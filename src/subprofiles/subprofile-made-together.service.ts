import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  MADE_TOGETHER_DEFAULT_LIMIT,
  MADE_TOGETHER_MAX_LIMIT,
} from './dto/list-made-together.query';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import {
  CreditPersonaIdentity,
  firstOutboundPersonaCredit,
  isCreditablePersona,
} from './subprofile-credit-graph';
import { SubprofileCreditGraphService } from './subprofile-credit-graph.service';
import {
  MadeTogetherResponse,
  MadeTogetherSource,
  toMadeTogetherView,
} from './subprofile-credits-response';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from './subprofile-takedown';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  VISIBLE_SECTIONS_PARAMETER,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';
import { TATTOO_BODY_PHOTO_SECTIONS } from './tattoo-artist-vocab';

/** How many of the newest qualifying credited items one request scans. */
export const MADE_TOGETHER_WINDOW = 80;

/** The most cards one persona may appear on, as author or partner. */
export const MADE_TOGETHER_PER_PERSONA_CAP = 2;

/** Sections whose credits never make a "Made together" card: the universal
 *  links section and the tattoo body-photo sections (a client's body photo is
 *  never a showcase piece). */
const EXCLUDED_SECTIONS: string[] = [
  SubprofileSection.Links,
  ...TATTOO_BODY_PHOTO_SECTIONS,
];

/**
 * The "Made together" strip: recent work where one persona credited another.
 *
 * A leaf reader on top of `SubprofileCreditGraphService`, which owns the
 * eligibility rules. Persona pairs follow the same rule the persona page
 * applies to its own credits (`isPersonaPairCredit`), with NO roster
 * comparison: a public persona page shows such a credit whatever the two
 * rosters are, so hiding the pair here would leak shared ownership through
 * the difference. Member credits never produce a card.
 */
@Injectable()
export class SubprofileMadeTogetherService {
  constructor(
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    private readonly creditGraph: SubprofileCreditGraphService,
    private readonly blockFilter: BlockFilterService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /**
   * At most `limit` cards (default 8, max 12), newest first. Queries per
   * request: one window scan, then (only when the window holds items) the
   * credit graph's handle registry, profiles, personas, moderation and block
   * lookups (at most five, no roster query), then one crop lookup when a card
   * was picked. Seven at most, whatever `limit` is.
   */
  async list(viewerId: string, limit?: number): Promise<MadeTogetherResponse> {
    const cardLimit = Math.min(
      Math.max(Math.trunc(limit ?? MADE_TOGETHER_DEFAULT_LIMIT), 1),
      MADE_TOGETHER_MAX_LIMIT,
    );
    const windowItems = await this.loadWindow(viewerId);
    if (!windowItems.length) return { items: [] };

    const creditedHandles = windowItems.flatMap((item) => item.collaborators);
    const authorIds = [
      ...new Set(windowItems.map((item) => item.subprofileId)),
    ];
    const directory = await this.creditGraph.resolveCounterparts(
      creditedHandles,
      authorIds,
      viewerId,
    );

    const sources = pickCards(windowItems, directory, cardLimit);
    if (!sources.length) return { items: [] };

    const crops = await this.mediaCropService.getMany(
      sources.flatMap(({ item, author, partner }) =>
        [item.imageUrl, author.avatarUrl, partner.avatarUrl].filter(
          (key): key is string => Boolean(key),
        ),
      ),
    );
    return toMadeTogetherView(sources, crops);
  }

  /**
   * The newest credited items of eligible authors, in ONE query. The base
   * predicates mirror the directory's (published, open, not removed, no
   * takedown, a handle, owner not blocked either way) so the window fills
   * with items that can qualify; `pickCards` still re-checks the author with
   * `isCreditablePersona`. `collaborators <> '{}'` matches the partial index
   * `IDX_subprofile_items_credited_recent`.
   */
  private async loadWindow(viewerId: string): Promise<SubprofileItem[]> {
    const qb = this.items
      .createQueryBuilder('item')
      .innerJoin(Subprofile, 'sp', 'sp.id = item.subprofileId')
      .select([
        'item.id',
        'item.subprofileId',
        'item.title',
        'item.imageUrl',
        'item.collaborators',
        'item.createdAt',
      ])
      .where("item.collaborators <> '{}'")
      .andWhere('item.section NOT IN (:...excludedSections)', {
        excludedSections: EXCLUDED_SECTIONS,
      })
      .andWhere(visibleSectionSql('"item"."section"', '"sp"."kind"'), {
        [VISIBLE_SECTIONS_PARAMETER]: VISIBLE_SECTIONS_BY_KIND_JSON,
      })
      .andWhere('sp.status = :published', {
        published: SubprofileStatus.Published,
      })
      .andWhere('sp.visibility = :open', { open: SubprofileVisibility.Open })
      .andWhere('sp.removedAt IS NULL')
      .andWhere('sp.handle IS NOT NULL')
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :subprofileSubjectType
            AND "cm"."subject_id" = "sp"."id"::text
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        )`,
        { subprofileSubjectType: SUBPROFILE_MODERATION_SUBJECT_TYPE },
      );
    this.blockFilter.excludeBlocked(qb, viewerId, '"sp"."user_id"');
    return qb
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'ASC')
      .limit(MADE_TOGETHER_WINDOW)
      .getMany();
  }
}

/**
 * Walks the window newest first and keeps an item when its author is
 * creditable, it has a persona partner, the unordered pair is new (so the
 * newest item of a pair wins) and neither persona already sits on
 * `MADE_TOGETHER_PER_PERSONA_CAP` cards. A persona never pairs with itself:
 * `firstOutboundPersonaCredit` skips the author's own handle.
 */
function pickCards(
  windowItems: readonly SubprofileItem[],
  directory: Parameters<typeof firstOutboundPersonaCredit>[2],
  cardLimit: number,
): MadeTogetherSource[] {
  const sources: MadeTogetherSource[] = [];
  const seenPairKeys = new Set<string>();
  const cardCountByPersonaId = new Map<string, number>();

  for (const item of windowItems) {
    if (sources.length >= cardLimit) break;
    const author: CreditPersonaIdentity | undefined = directory.personaById.get(
      item.subprofileId,
    );
    if (!author || !isCreditablePersona(author)) continue;
    const partner = firstOutboundPersonaCredit(
      author,
      item.collaborators,
      directory,
    );
    if (!partner) continue;

    const pairKey = [author.id, partner.id].sort().join(':');
    if (seenPairKeys.has(pairKey)) continue;
    if (
      (cardCountByPersonaId.get(author.id) ?? 0) >=
        MADE_TOGETHER_PER_PERSONA_CAP ||
      (cardCountByPersonaId.get(partner.id) ?? 0) >=
        MADE_TOGETHER_PER_PERSONA_CAP
    ) {
      continue;
    }

    seenPairKeys.add(pairKey);
    for (const personaId of [author.id, partner.id]) {
      cardCountByPersonaId.set(
        personaId,
        (cardCountByPersonaId.get(personaId) ?? 0) + 1,
      );
    }
    sources.push({
      item: {
        id: item.id,
        title: item.title,
        imageUrl: item.imageUrl,
        createdAt: item.createdAt,
      },
      author,
      partner,
    });
  }
  return sources;
}
