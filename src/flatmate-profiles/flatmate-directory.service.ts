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

/**
 * Member-only browse over flatmate profiles. When the viewer has their own
 * profile, opposite-type candidates are scored + ranked (best match first) and
 * same-type profiles follow unscored; without a profile, results are newest-
 * first with `matchScore: null`. The viewer's own profile is always excluded.
 */
@Injectable()
export class FlatmateDirectoryService {
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

    // Ranked path: pull a bounded set, score opposite-type candidates, sort
    // (opposite-type by score desc; same-type after, newest-first), paginate.
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
    // Only the top MATCH_CANDIDATE_CAP candidates are ranked, but `total`
    // must reflect the full filtered count, not the capped/scored set — recount
    // over the same filters (unlimited) rather than using scored.length.
    const total = await this.filteredQb(viewerId, query).getCount();
    const start = (page - 1) * PAGE_SIZE;
    const pageSlice = scored.slice(start, start + PAGE_SIZE);
    const items = await this.mapRows(
      pageSlice.map((scoredRow) => scoredRow.row),
      pageSlice.map((scoredRow) => scoredRow.match),
      viewer.type,
    );
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
