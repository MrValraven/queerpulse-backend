import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, PAGE_SIZE, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import {
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';
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
  ) {}

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
      // No viewer profile → `matches` visibility can never resolve, so only
      // `public`/`members` profiles reveal their identity fields here.
      const items = await this.mapRows(
        rows,
        rows.map(() => null),
        null,
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
    const items = await this.mapRows(orderedRows, orderedMatches, viewer.type);
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
    const isOwner = profile.ownerId === viewerId;
    let match: MatchResult | null = null;
    let viewerProfileType: FlatmateProfileType | null = null;
    if (!isOwner) {
      const viewer = await this.flatmates.findOne({
        where: { ownerId: viewerId },
      });
      viewerProfileType = viewer?.type ?? null;
      if (viewer && viewer.type !== profile.type) {
        const revealCandidateIdentity = canRevealIdentity(profile, {
          isOwner: false,
          viewerProfileType,
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
      { isOwner, viewerProfileType },
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
    const scored = candidates.map((row) => {
      if (row.type === viewer.type) return { row, match: null };
      // Score with THIS viewer's permission to see the candidate's identity, so
      // the engine redacts special-category reason specifics it may not reveal.
      const revealCandidateIdentity = canRevealIdentity(row, {
        isOwner: false,
        viewerProfileType: viewer.type,
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
    return qb;
  }

  private async mapRows(
    rows: FlatmateProfile[],
    matches: (MatchResult | null)[],
    viewerProfileType: FlatmateProfileType | null,
  ): Promise<FlatmateProfileDTO[]> {
    if (!rows.length) return [];
    const ownerIds = rows.map((row) => row.ownerId);
    const refs = await new MemberLookup(this.profiles).byUserIds(ownerIds);
    const levels = await this.verification.levelsForUsers(ownerIds);
    // Browse always excludes the viewer's own profile, so `isOwner` is false
    // for every row here; identity gating rests on consent + visibility.
    return rows.map((row, index) =>
      toFlatmateProfileDTO(
        row,
        refs.get(row.ownerId) ?? null,
        matches[index] ?? null,
        {
          isOwner: false,
          viewerProfileType,
        },
        levels.get(row.ownerId) ?? VerificationLevel.Email,
      ),
    );
  }
}
