import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { normalizePage, PAGE_SIZE, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { FlatmateLikesService } from './flatmate-likes.service';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import { FlatmateProfile } from './entities/flatmate-profile.entity';
import {
  canRevealIdentity,
  FlatmateProfileDTO,
  toFlatmateProfileDTO,
} from './flatmate-profile-response';
import { MatchResult, scoreMatch } from './flatmate-match';

// Match ranking is computed in-memory (a JS score can't be an ORDER BY), so the
// ranked path bounds how many candidates it pulls. Ample for launch scale; the
// board is small. Revisit with a materialized score if it ever isn't.
const MATCH_CANDIDATE_CAP = 500;

/** One ranked candidate: the row id and the score that placed it. The rows are
 * deliberately NOT retained (see `browse`). */
interface RankedEntry {
  id: string;
  match: MatchResult | null;
}

interface RankingCacheEntry {
  ordering: RankedEntry[];
  expiresAt: number;
}

// Short enough that a new or edited profile shows up in the ranking almost
// immediately, long enough to cover a member paging through the board. Bounded
// by entry count so a burst of distinct filter combinations cannot grow the
// process's memory without limit.
const RANKING_CACHE_TTL_MS = 30 * 1000;
const RANKING_CACHE_MAX_ENTRIES = 500;

/**
 * Member-only browse over flatmate profiles. When the viewer has their own
 * profile, opposite-type candidates are scored + ranked (best match first) and
 * same-type profiles follow unscored; without a profile, results are newest-
 * first with `matchScore: null`. The viewer's own profile is always excluded.
 */
@Injectable()
export class FlatmateDirectoryService {
  /** Per-(viewer, filter set) ranked ordering, held for `RANKING_CACHE_TTL_MS`
   * so paging the board does not re-score the whole candidate set each time. */
  private readonly rankingCache = new Map<string, RankingCacheEntry>();

  constructor(
    @InjectRepository(FlatmateProfile)
    private readonly flatmates: Repository<FlatmateProfile>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
    private readonly verification: VerificationService,
    // Read-only: a `hide_content`/`remove_content` takedown on a `flatmate`
    // subject (keyed by the profile slug, which is what the report modal on
    // `FlatmateCard` sends) withholds the profile from every member read below.
    private readonly contentModeration: ContentModerationService,
    // Resolves "are these two actually matched?", which is what `matches`
    // identity visibility means as of ENG-51. Always through the batched
    // `mutuallyMatchedProfileIds`, never one call per row. Same module, and
    // `FlatmateLikesService` depends on nothing here, so there is no cycle.
    private readonly likes: FlatmateLikesService,
  ) {}

  // A flatmate profile is reported (and taken down) under the `flatmate`
  // subject code, keyed by the profile slug. A hidden OR removed profile
  // vanishes from browse, detail and the discovery deck for everyone: this is a
  // member surface with no per-viewer staff role, so a takedown withholds it
  // entirely, exactly as `HousingDirectoryService` treats a `housing` takedown.
  // The owner still reaches their own row through the owner-gated
  // `/flatmate-profiles/mine` routes, which do not re-check this state.
  private static readonly SUBJECT_TYPE = 'flatmate';

  /**
   * NOT EXISTS predicate dropping any profile under a `flatmate` takedown
   * (hidden OR removed) from a profile query builder (alias `p`). Applied
   * in-query rather than after the fetch for the reason
   * `BlockFilterService.excludeHidden` documents: filtering a fixed-size page
   * afterwards under-fills it and, under OFFSET pagination, permanently skips
   * the row just past the dropped one. A `NOT EXISTS` subquery also keeps the
   * builder join-free, so the `.skip()`/`.take()` pagination this service
   * already uses stays correct. Mirrors
   * `HousingDirectoryService.excludeModeratedListings`.
   */
  private excludeModeratedProfiles(
    qb: SelectQueryBuilder<FlatmateProfile>,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :flatmateSubjectType
          AND "cm"."subject_id" = p.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { flatmateSubjectType: FlatmateDirectoryService.SUBJECT_TYPE },
    );
  }

  async browse(
    viewerId: string,
    query: BrowseFlatmateProfilesQuery,
  ): Promise<Paginated<FlatmateProfileDTO>> {
    const page = normalizePage(query.page);
    const viewer = await this.flatmates.findOne({
      where: { ownerId: viewerId },
    });
    const qb = this.filteredQb(viewerId, query).orderBy('p.created_at', 'DESC');

    if (!viewer) {
      const [rows, total] = await qb
        .skip((page - 1) * PAGE_SIZE)
        .take(PAGE_SIZE)
        .getManyAndCount();
      // No viewer profile, and a list payload regardless, so no Art.9 field is
      // served on this path at all (ENG-51).
      const items = await this.mapRows(
        rows,
        rows.map(() => null),
      );
      return { items, total, page, pageSize: PAGE_SIZE };
    }

    // Ranked path: the ORDER is computed once per (viewer, filter set) and
    // cached for a few seconds, then each page reads its slice out of it. The
    // score is a JS function, so ranking means pulling up to
    // `MATCH_CANDIDATE_CAP` rows and scoring every one; doing that again for
    // page 2, 3, 4 was the same 500-row fetch and 500 score computations per
    // page view, which made paging the board the most expensive read in the
    // module.
    const cacheKey = this.rankingCacheKey(viewerId, viewer, query);
    const ordering =
      this.readRanking(cacheKey) ??
      this.writeRanking(cacheKey, await this.rankCandidates(viewer, qb));

    // `total` is the size of the RANKED set, not the full filtered count. The
    // previous unlimited `getCount()` (a second query on every page) could
    // report a total above the cap while only `MATCH_CANDIDATE_CAP` rows were
    // ever reachable, so the pager offered pages that came back empty.
    const total = ordering.length;
    const start = (page - 1) * PAGE_SIZE;
    const pageSlice = ordering.slice(start, start + PAGE_SIZE);
    if (!pageSlice.length) {
      return { items: [], total, page, pageSize: PAGE_SIZE };
    }

    // Re-read the page's rows through the SAME filtered query rather than
    // serving them out of the cache. That keeps the cache to ids + scores
    // (cheap to hold) and, more importantly, re-applies block/mute severance
    // and any profile edit at read time — a member blocked after the ranking
    // was computed drops out of the page instead of lingering for the TTL.
    const rows = await this.filteredQb(viewerId, query)
      .andWhere('p.id IN (:...pageIds)', {
        pageIds: pageSlice.map((entry) => entry.id),
      })
      .getMany();
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const orderedRows: FlatmateProfile[] = [];
    const orderedMatches: (MatchResult | null)[] = [];
    for (const entry of pageSlice) {
      const row = rowById.get(entry.id);
      if (!row) continue;
      orderedRows.push(row);
      orderedMatches.push(entry.match);
    }
    const items = await this.mapRows(orderedRows, orderedMatches);
    return { items, total, page, pageSize: PAGE_SIZE };
  }

  async detail(viewerId: string, slug: string): Promise<FlatmateProfileDTO> {
    const profile = await this.flatmates.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Flatmate profile not found');
    }
    // The single-item path must enforce the same block severance the browse
    // list gets — a block either way hides the profile entirely (404, not a
    // "blocked" signal that would confirm the profile exists).
    if (await this.blockFilter.isBlockedEitherWay(viewerId, profile.ownerId)) {
      throw new NotFoundException('Flatmate profile not found');
    }
    // A moderator takedown (hidden OR removed) withholds the detail as a 404,
    // the same withhold-entirely behaviour browse applies in-query above. The
    // owner is included: an owner who wants their own row edits it through
    // `/flatmate-profiles/mine`, and leaving the public detail live for them
    // would leak the shareable link back into circulation.
    const moderation = await this.contentModeration.stateFor(
      FlatmateDirectoryService.SUBJECT_TYPE,
      slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Flatmate profile not found');
    }
    const isOwner = profile.ownerId === viewerId;
    let match: MatchResult | null = null;
    // `matches` visibility now needs an actual mutual match (ENG-51), and the
    // detail response is the ONLY place the Art.9 fields are served, so this is
    // where that question gets asked. One profile, so the batched lookup runs
    // over a single-element set. The owner never needs it: they see their own
    // data unconditionally.
    let hasMutualMatch = false;
    if (!isOwner) {
      const viewer = await this.flatmates.findOne({
        where: { ownerId: viewerId },
      });
      hasMutualMatch = (
        await this.likes.mutuallyMatchedProfileIds(viewerId, [
          { id: profile.id, ownerId: profile.ownerId },
        ])
      ).has(profile.id);
      if (viewer && viewer.type !== profile.type) {
        const revealCandidateIdentity = canRevealIdentity(profile, {
          isOwner: false,
          hasMutualMatch,
          isListSurface: false,
        });
        match = scoreMatch(viewer, profile, { revealCandidateIdentity });
      }
    }
    const refs = await new MemberLookup(this.profiles).byUserIds([
      profile.ownerId,
    ]);
    const level = await this.verification.levelForUser(profile.ownerId);
    return toFlatmateProfileDTO(
      profile,
      refs.get(profile.ownerId) ?? null,
      match,
      { isOwner, hasMutualMatch, isListSurface: false },
      level,
    );
  }

  // --- ranking ---

  /** Pull a bounded candidate set, score the opposite-type ones and sort
   * (opposite-type by score desc; same-type after, newest-first). Returns just
   * the ids + scores — the rows themselves are re-read per page. */
  private async rankCandidates(
    viewer: FlatmateProfile,
    qb: SelectQueryBuilder<FlatmateProfile>,
  ): Promise<RankedEntry[]> {
    const candidates = await qb.take(MATCH_CANDIDATE_CAP).getMany();
    // ONE batched lookup for the whole candidate set (ENG-51). `matches`
    // visibility needs a real mutual match now, and the match engine redacts
    // safe-space reason specifics against the same permission, so every scored
    // candidate needs the answer. Asking per candidate would be an N+1 across
    // `MATCH_CANDIDATE_CAP` rows on the board's main read.
    const mutuallyMatchedProfileIds =
      await this.likes.mutuallyMatchedProfileIds(
        viewer.ownerId,
        candidates.map((row) => ({ id: row.id, ownerId: row.ownerId })),
      );
    const scored = candidates.map((row) => {
      if (row.type === viewer.type) return { row, match: null };
      // Score with THIS viewer's permission to see the candidate's identity, so
      // the engine redacts special-category reason specifics it may not reveal.
      //
      // `isListSurface: false` even though this feeds the browse list, and that
      // is deliberate: the surface flag governs the raw Art.9 FIELDS, which the
      // list drops unconditionally. A match reason is a derived, already
      // redacted sentence the cards do render, and over-redacting it here would
      // degrade the board for the genuine matches this change exists to serve.
      // The set that reaches it is strictly smaller than before: mutual matches
      // only, where it used to be every opposite-type viewer.
      const revealCandidateIdentity = canRevealIdentity(row, {
        isOwner: false,
        hasMutualMatch: mutuallyMatchedProfileIds.has(row.id),
        isListSurface: false,
      });
      return {
        row,
        match: scoreMatch(viewer, row, { revealCandidateIdentity }),
      };
    });
    scored.sort((a, b) => {
      const left = a.match?.score ?? null;
      const right = b.match?.score ?? null;
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    });
    return scored.map(({ row, match }) => ({ id: row.id, match }));
  }

  /**
   * Cache identity for one ranked ordering. Every input the ranking depends on
   * has to be in here or a stale order would be served: the viewer, their own
   * profile's `updatedAt` (the score is computed FROM it, so editing a
   * preference must re-rank immediately rather than after the TTL), and every
   * filter — `tags` sorted, because `?tags=a&tags=b` and `?tags=b&tags=a` are
   * the same query.
   */
  private rankingCacheKey(
    viewerId: string,
    viewer: FlatmateProfile,
    query: BrowseFlatmateProfilesQuery,
  ): string {
    return JSON.stringify([
      viewerId,
      viewer.updatedAt instanceof Date
        ? viewer.updatedAt.getTime()
        : viewer.updatedAt,
      query.type ?? null,
      query.neighbourhood?.toLowerCase() ?? null,
      query.budgetMax ?? null,
      query.moveInBy ?? null,
      [...(query.tags ?? [])].sort(),
    ]);
  }

  private readRanking(cacheKey: string): RankedEntry[] | null {
    const entry = this.rankingCache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.rankingCache.delete(cacheKey);
      return null;
    }
    return entry.ordering;
  }

  private writeRanking(
    cacheKey: string,
    ordering: RankedEntry[],
  ): RankedEntry[] {
    // Cheap bound: when full, evict the oldest insertion (Map preserves order).
    // Same shape as `GeocodeService`'s in-process TTL cache.
    if (this.rankingCache.size >= RANKING_CACHE_MAX_ENTRIES) {
      for (const oldest of this.rankingCache.keys()) {
        this.rankingCache.delete(oldest);
        break;
      }
    }
    this.rankingCache.set(cacheKey, {
      ordering,
      expiresAt: Date.now() + RANKING_CACHE_TTL_MS,
    });
    return ordering;
  }

  // --- internals ---

  private filteredQb(
    viewerId: string,
    query: BrowseFlatmateProfilesQuery,
  ): SelectQueryBuilder<FlatmateProfile> {
    const qb = this.flatmates
      .createQueryBuilder('p')
      .where('p.owner_id != :viewerId', { viewerId });

    if (query.type) {
      qb.andWhere('p.type = :type', { type: query.type });
    }
    if (query.neighbourhood) {
      qb.andWhere('LOWER(p.neighbourhood) = LOWER(:neighbourhood)', {
        neighbourhood: query.neighbourhood,
      });
    }
    if (query.budgetMax !== undefined) {
      qb.andWhere('p.budget_euros <= :budgetMax', {
        budgetMax: query.budgetMax,
      });
    }
    if (query.moveInBy) {
      qb.andWhere('(p.move_in_from IS NULL OR p.move_in_from <= :moveInBy)', {
        moveInBy: query.moveInBy,
      });
    }
    if (query.tags && query.tags.length) {
      // Postgres array overlap: at least one shared tag. node-postgres binds a
      // JS string[] as a text[] literal.
      qb.andWhere('p.lifestyle_tags && :tags', { tags: query.tags });
    }
    // Hide profiles of members blocked either way (and muted, one-way) — same
    // severance `detail()` applies via `isBlockedEitherWay`, applied in-query so
    // both the page and `getCount()` built off this helper are covered. The raw
    // column reference must match the DB's snake_case name (SnakeNamingStrategy).
    this.blockFilter.excludeHidden(qb, viewerId, '"p"."owner_id"');
    // Moderator takedowns, applied in the same in-query place and for the same
    // reason. Every read that reaches this helper is covered: the unranked page
    // + its `getManyAndCount` total, the ranked candidate fetch (so the ranked
    // `total` agrees with the list), and the ranked page's row re-read.
    this.excludeModeratedProfiles(qb);
    return qb;
  }

  /**
   * Maps a page of browse rows.
   *
   * `hasMutualMatch: false` is the load-bearing argument (ENG-51). A `matches`
   * profile therefore never reveals its Art.9 fields on the board, which is the
   * bulk read the finding was about: it used to hand over the consenting half of
   * the opposite side twenty rows at a time to anyone who had set their own
   * `type`. A mutual match reads those fields on the profile's own page.
   *
   * It is deliberately NOT resolved here. Doing so would mean the grid could
   * show identity data for matched rows, which is a nicety, and the cost is that
   * the board's main read would carry Art.9 data again for a set that a future
   * change to the gate could widen. `public`/`members` rows are unaffected
   * either way: they do not consult this flag, so an owner who chose to be
   * visible to any member still is, on the cards and in the deck.
   *
   * `isListSurface: true` then holds the `matches` case shut a second time, so a
   * caller that later starts resolving matches here cannot reopen it by
   * accident. Both are passed explicitly, and fail closed, rather than being
   * optional, so a new caller cannot inherit a permissive default.
   */
  private async mapRows(
    rows: FlatmateProfile[],
    matches: (MatchResult | null)[],
  ): Promise<FlatmateProfileDTO[]> {
    if (!rows.length) return [];
    const ownerIds = rows.map((row) => row.ownerId);
    const refs = await new MemberLookup(this.profiles).byUserIds(ownerIds);
    const levels = await this.verification.levelsForUsers(ownerIds);
    // Browse always excludes the viewer's own profile, so `isOwner` is false
    // for every row here.
    return rows.map((row, index) =>
      toFlatmateProfileDTO(
        row,
        refs.get(row.ownerId) ?? null,
        matches[index] ?? null,
        {
          isOwner: false,
          hasMutualMatch: false,
          isListSurface: true,
        },
        levels.get(row.ownerId) ?? VerificationLevel.Email,
      ),
    );
  }
}
