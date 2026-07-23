import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, PAGE_SIZE, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import { FlatmateProfile } from './entities/flatmate-profile.entity';
import {
  FlatmateProfileDTO,
  toFlatmateProfileDTO,
} from './flatmate-profile-response';
import { scoreMatch } from './flatmate-match';

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
      const items = await this.mapRows(
        rows,
        rows.map(() => null),
      );
      return { items, total, page, pageSize: PAGE_SIZE };
    }

    // Ranked path: pull a bounded set, score opposite-type candidates, sort
    // (opposite-type by score desc; same-type after, newest-first), paginate.
    const candidates = await qb.take(MATCH_CANDIDATE_CAP).getMany();
    const scored = candidates.map((row) => ({
      row,
      score: row.type !== viewer.type ? scoreMatch(viewer, row) : null,
    }));
    scored.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });
    // Only the top MATCH_CANDIDATE_CAP candidates are ranked, but `total`
    // must reflect the full filtered count, not the capped/scored set — recount
    // over the same filters (unlimited) rather than using scored.length.
    const total = await this.filteredQb(viewerId, query).getCount();
    const start = (page - 1) * PAGE_SIZE;
    const pageSlice = scored.slice(start, start + PAGE_SIZE);
    const items = await this.mapRows(
      pageSlice.map((s) => s.row),
      pageSlice.map((s) => s.score),
    );
    return { items, total, page, pageSize: PAGE_SIZE };
  }

  async detail(viewerId: string, slug: string): Promise<FlatmateProfileDTO> {
    const profile = await this.flatmates.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Flatmate profile not found');
    }
    let matchScore: number | null = null;
    if (profile.ownerId !== viewerId) {
      const viewer = await this.flatmates.findOne({
        where: { ownerId: viewerId },
      });
      if (viewer && viewer.type !== profile.type) {
        matchScore = scoreMatch(viewer, profile);
      }
    }
    const refs = await new MemberLookup(this.profiles).byUserIds([
      profile.ownerId,
    ]);
    return toFlatmateProfileDTO(
      profile,
      refs.get(profile.ownerId) ?? null,
      matchScore,
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
    return qb;
  }

  private async mapRows(
    rows: FlatmateProfile[],
    scores: (number | null)[],
  ): Promise<FlatmateProfileDTO[]> {
    if (!rows.length) return [];
    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((r) => r.ownerId),
    );
    return rows.map((row, index) =>
      toFlatmateProfileDTO(row, refs.get(row.ownerId) ?? null, scores[index]),
    );
  }
}
