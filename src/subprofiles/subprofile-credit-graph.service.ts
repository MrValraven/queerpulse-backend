import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { normalizeHandle } from '../common/handles';
import {
  ContentModerationService,
  type ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileItem } from './entities/subprofile-item.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  CounterpartDirectory,
  CreditItemRef,
  CreditMemberIdentity,
  CreditPersonaIdentity,
  CreditSubject,
  summarizeCardCredits,
} from './subprofile-credit-graph';
import {
  CardCreditsView,
  emptyCardCredits,
  toCardCreditsView,
} from './subprofile-credits-response';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from './subprofile-takedown';

/**
 * Safety cap on the OUTBOUND scan (the page's own credited items). A page of
 * 100 personas is naturally bounded by their item counts and reads far fewer.
 */
export const OUTBOUND_CREDIT_SCAN_LIMIT = 5000;

/**
 * Cap on the INBOUND scan (other personas' items naming a page handle), which
 * is bounded only by how often the page's personas are credited. Newest items
 * are read first. A separate query, so inbound volume never pushes older
 * outbound credits out.
 */
export const INBOUND_CREDIT_SCAN_LIMIT = 2000;

export interface ResolveCounterpartsOptions {
  /**
   * Persona ids whose roster (`subprofile_members`) to load. Only the member
   * rule of a LINKED subject reads a roster, so pass the subjects whose member
   * credits are judged (the directory page's rows). The persona rules read no
   * roster at all.
   */
  rosterPersonaIds?: readonly string[];
}

/**
 * Loads the persona credit graph in a bounded number of batched queries and
 * hands it to the pure rules in `subprofile-credit-graph.ts`.
 *
 * A leaf service: it reads repositories, moderation state and blocks, and
 * depends on no other persona service. It must never inject
 * `SubprofilePublicReadService`, which itself depends on this service.
 */
@Injectable()
export class SubprofileCreditGraphService {
  constructor(
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Handle)
    private readonly handleRegistry: Repository<Handle>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    private readonly contentModeration: ContentModerationService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * Resolves credit counterparts as `viewerId` may see them, in at most six
   * queries whatever the input size: the handle registry, then profiles and
   * personas in parallel, then rosters, moderation state and blocks in
   * parallel. Never narrows by eligibility itself: every persona comes back
   * with its status, visibility, link visibility, removal, takedown and
   * owner-block state so the pure rules decide.
   *
   * - `handles`: raw credit handles (normalized here). Member handles resolve
   *   to `memberByHandle`, persona handles to `personaIdByHandle` plus
   *   `personaById`.
   * - `personaIds`: personas to load by id (inbound item authors, or the
   *   authors of "Made together" items). Pass every author whose eligibility
   *   the caller judges: the caller checks `isCreditablePersona(author)`
   *   itself, since a partner rule never judges the author.
   * - `options.rosterPersonaIds`: the subjects whose member credits are
   *   judged. Rosters load only for these, and only when a member handle
   *   resolved.
   *
   * Crops are not loaded here: a caller that maps avatars or item images
   * batches them through `MediaCropService.getMany` itself.
   */
  async resolveCounterparts(
    handles: readonly string[],
    personaIds: readonly string[],
    viewerId: string,
    options: ResolveCounterpartsOptions = {},
  ): Promise<CounterpartDirectory> {
    const normalizedHandles = [
      ...new Set(handles.map((handle) => normalizeHandle(handle))),
    ].filter(Boolean);
    const handleRows = normalizedHandles.length
      ? await this.handleRegistry.find({
          where: { name: In(normalizedHandles) },
          select: {
            name: true,
            ownerKind: true,
            userId: true,
            subprofileId: true,
          },
        })
      : [];

    const memberHandleRows = handleRows.filter(
      (row) => row.ownerKind === HandleOwnerKind.Profile && row.userId,
    );
    const personaHandleRows = handleRows.filter(
      (row) => row.ownerKind === HandleOwnerKind.Subprofile && row.subprofileId,
    );
    const memberUserIds = [
      ...new Set(memberHandleRows.map((row) => row.userId as string)),
    ];
    const personaIdsToLoad = [
      ...new Set([
        ...personaHandleRows.map((row) => row.subprofileId as string),
        ...personaIds,
      ]),
    ];

    const [profileRows, personaRows] = await Promise.all([
      memberUserIds.length
        ? this.profiles.find({
            where: { userId: In(memberUserIds) },
            select: {
              userId: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              photoVisible: true,
            },
          })
        : Promise.resolve([] as Profile[]),
      personaIdsToLoad.length
        ? this.subprofiles.find({
            where: { id: In(personaIdsToLoad) },
            select: {
              id: true,
              handle: true,
              displayName: true,
              avatarUrl: true,
              accent: true,
              kind: true,
              status: true,
              visibility: true,
              linkVisibility: true,
              removedAt: true,
              userId: true,
            },
          })
        : Promise.resolve([] as Subprofile[]),
    ]);

    const loadedPersonaIds = personaRows.map((persona) => persona.id);
    // Rosters matter only to member credits, so no member handle means no
    // roster query.
    const rosterIds = profileRows.length
      ? [...new Set(options.rosterPersonaIds ?? [])]
      : [];
    const candidateBlockedIds = [
      ...new Set([
        ...personaRows.map((persona) => persona.userId),
        ...profileRows.map((profile) => profile.userId),
      ]),
    ];
    const [rosterRows, moderationStates, blockedUserIds] = await Promise.all([
      rosterIds.length
        ? this.members.find({
            where: { subprofileId: In(rosterIds) },
            select: { subprofileId: true, userId: true },
          })
        : Promise.resolve([] as SubprofileMember[]),
      loadedPersonaIds.length
        ? this.contentModeration.statesFor(
            SUBPROFILE_MODERATION_SUBJECT_TYPE,
            loadedPersonaIds,
          )
        : Promise.resolve(new Map<string, ContentModerationState>()),
      candidateBlockedIds.length
        ? this.blockFilter.blockedUserIds(viewerId, candidateBlockedIds)
        : Promise.resolve(new Set<string>()),
    ]);

    const rosterMembersById = new Map<string, string[]>();
    for (const row of rosterRows) {
      const roster = rosterMembersById.get(row.subprofileId);
      if (roster) roster.push(row.userId);
      else rosterMembersById.set(row.subprofileId, [row.userId]);
    }

    const personaById = new Map<string, CreditPersonaIdentity>();
    for (const persona of personaRows) {
      const moderationState = moderationStates.get(persona.id);
      personaById.set(persona.id, {
        id: persona.id,
        handle: persona.handle,
        displayName: persona.displayName,
        avatarUrl: persona.avatarUrl,
        accent: persona.accent,
        kind: persona.kind,
        status: persona.status,
        visibility: persona.visibility,
        linkVisibility: persona.linkVisibility,
        removedAt: persona.removedAt,
        userId: persona.userId,
        isUnderTakedown: Boolean(
          moderationState?.hidden || moderationState?.removed,
        ),
        isOwnerBlocked: blockedUserIds.has(persona.userId),
      });
    }

    const personaIdByHandle = new Map<string, string>();
    for (const row of personaHandleRows) {
      const personaId = row.subprofileId as string;
      if (personaById.has(personaId))
        personaIdByHandle.set(row.name, personaId);
    }

    const profileByUserId = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const memberByHandle = new Map<string, CreditMemberIdentity>();
    for (const row of memberHandleRows) {
      const profile = profileByUserId.get(row.userId as string);
      if (!profile) continue;
      memberByHandle.set(row.name, {
        userId: profile.userId,
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        // The member's own `photoVisible` toggle, the gate `toVisibleAvatarUrl`
        // applies: a hidden photo is never shown as a credit face.
        avatarUrl: profile.photoVisible ? profile.avatarUrl : null,
        isBlocked: blockedUserIds.has(profile.userId),
      });
    }

    return {
      personaById,
      personaIdByHandle,
      memberByHandle,
      rosterMembersById,
    };
  }

  /**
   * Credit count and faces for every directory row, keyed by persona id. At
   * most eight queries per page: two credited-item scans in parallel (the
   * page's own items by `item.subprofile_id IN (...)`, and other items that
   * list an unlinked row's handle via `collaborators && :handles::text[]`),
   * then `resolveCounterparts`. A page whose rows carry no credits stops after
   * the scans.
   */
  async loadCardCreditsFor(
    rows: readonly CreditSubject[],
    viewerId: string,
  ): Promise<Map<string, CardCreditsView>> {
    const creditsById = new Map<string, CardCreditsView>();
    if (!rows.length) return creditsById;
    for (const row of rows) creditsById.set(row.id, emptyCardCredits());

    const subjectIds = rows.map((row) => row.id);
    const subjectIdSet = new Set(subjectIds);
    const inboundHandles = [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.linkVisibility === SubprofileLinkVisibility.Unlinked &&
              row.handle,
          )
          .map((row) => normalizeHandle(row.handle as string)),
      ),
    ];
    const [outboundItems, inboundItems] = await Promise.all([
      this.loadOutboundItems(subjectIds),
      inboundHandles.length
        ? this.loadInboundItems(inboundHandles)
        : Promise.resolve([] as CreditItemRef[]),
    ]);
    if (!outboundItems.length && !inboundItems.length) return creditsById;

    const inboundHandleSet = new Set(inboundHandles);
    const outboundItemsBySubject = new Map<string, CreditItemRef[]>();
    const inboundItemsByHandle = new Map<string, CreditItemRef[]>();
    const outboundHandles = new Set<string>();
    const inboundAuthorIds = new Set<string>();
    for (const item of outboundItems) {
      if (!subjectIdSet.has(item.subprofileId)) continue;
      pushInto(outboundItemsBySubject, item.subprofileId, item);
      for (const handle of item.collaborators) outboundHandles.add(handle);
    }
    for (const item of inboundItems) {
      for (const rawHandle of item.collaborators) {
        const handle = normalizeHandle(rawHandle);
        if (!inboundHandleSet.has(handle)) continue;
        pushInto(inboundItemsByHandle, handle, item);
        inboundAuthorIds.add(item.subprofileId);
      }
    }
    if (!outboundHandles.size && !inboundAuthorIds.size) return creditsById;

    const directory = await this.resolveCounterparts(
      [...outboundHandles],
      [...inboundAuthorIds],
      viewerId,
      { rosterPersonaIds: subjectIds },
    );
    for (const row of rows) {
      const subjectHandle = row.handle ? normalizeHandle(row.handle) : null;
      const subjectInboundItems = subjectHandle
        ? (inboundItemsByHandle.get(subjectHandle) ?? [])
        : [];
      const subjectItems = [
        ...(outboundItemsBySubject.get(row.id) ?? []),
        ...subjectInboundItems,
      ];
      if (!subjectItems.length) continue;
      creditsById.set(
        row.id,
        toCardCreditsView(summarizeCardCredits(row, subjectItems, directory)),
      );
    }
    return creditsById;
  }

  /**
   * The page's own credited items (outbound). `collaborators <> '{}'` matches
   * the partial index `IDX_subprofile_items_credited_recent`. Only the three
   * columns the rules read are projected.
   */
  private async loadOutboundItems(
    subjectIds: readonly string[],
  ): Promise<CreditItemRef[]> {
    const rows = await this.items
      .createQueryBuilder('item')
      .select([
        'item.id',
        'item.subprofileId',
        'item.collaborators',
        'item.createdAt',
      ])
      .where('item.subprofileId IN (:...subjectIds)', {
        subjectIds: [...subjectIds],
      })
      .andWhere("item.collaborators <> '{}'")
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'ASC')
      .limit(OUTBOUND_CREDIT_SCAN_LIMIT)
      .getMany();
    return rows.map(toCreditItemRef);
  }

  /**
   * Other items that list one of `inboundHandles` (inbound), newest first and
   * capped. The handles bind as ONE text array parameter.
   */
  private async loadInboundItems(
    inboundHandles: readonly string[],
  ): Promise<CreditItemRef[]> {
    const rows = await this.items
      .createQueryBuilder('item')
      .select([
        'item.id',
        'item.subprofileId',
        'item.collaborators',
        'item.createdAt',
      ])
      .where("item.collaborators <> '{}'")
      .andWhere('item.collaborators && :handles::text[]', {
        handles: [...inboundHandles],
      })
      .orderBy('item.createdAt', 'DESC')
      .addOrderBy('item.id', 'ASC')
      .limit(INBOUND_CREDIT_SCAN_LIMIT)
      .getMany();
    return rows.map(toCreditItemRef);
  }
}

function toCreditItemRef(row: SubprofileItem): CreditItemRef {
  return {
    subprofileId: row.subprofileId,
    collaborators: row.collaborators ?? [],
    createdAt: row.createdAt,
  };
}

function pushInto<Value>(
  map: Map<string, Value[]>,
  key: string,
  value: Value,
): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
