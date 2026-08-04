import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CompanyOpenRolesService } from '../jobs/company-open-roles.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { JobCardDTO, JobCompanyRef } from '../jobs/job-response';
import { Profile } from '../users/entities/profile.entity';
import {
  CompanyCardDTO,
  CompanyDetailDTO,
  CompanyReviewAggregates,
  CompanyReviewDTO,
  computeReviewAggregates,
  EMPTY_REVIEW_AGGREGATES,
  toCompanyCard,
  toCompanyDetail,
  toCompanyReview,
} from './company-response';
import { CompanyReview } from './entities/company-review.entity';
import { CompanyTeamMember } from './entities/company-team-member.entity';
import {
  Company,
  CompanyHiringContact,
  CompanyInfoItem,
  CompanyValue,
  CompanyWorkItem,
} from './entities/company.entity';

// `imageUrl` is optional on the request shape (`CompanyWorkItemDto`) but
// non-nullable-and-required-to-be-`null`-or-`string` on the entity column —
// this is the input-side shape (structurally matches `CompanyWorkItemDto`);
// `normalizeWork` below bridges the two at the persistence boundary.
export interface CompanyWorkItemInput {
  label: string;
  imageUrl?: string;
}

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on
// the QueryFailedError or on the wrapped driverError depending on the path.
// Mirrors `CommunitiesService`'s identical helper (file-local there too, not
// shared/exported — kept consistent with that precedent).
export interface CreateCompanyInput {
  nameText: string;
  tagline: string;
  about: string;
  queerRun?: boolean;
  queerLed?: boolean;
  values?: CompanyValue[];
  info?: CompanyInfoItem[];
  team?: string[]; // member slugs -> seeded as `company_team_members` rows
  hiringContact?: CompanyHiringContact;
  work?: CompanyWorkItemInput[];
  handle?: string; // desired slug; defaults from nameText
}

/** Bridges `CompanyWorkItemInput`'s optional `imageUrl` to the entity
 * column's `string | null`. */
function normalizeWork(items?: CompanyWorkItemInput[]): CompanyWorkItem[] {
  return (items ?? []).map((w) => ({
    label: w.label,
    imageUrl: w.imageUrl ?? null,
  }));
}

// `handle` only ever applies at creation time (mirrors
// `UpdateCommunityInput`'s identical "handle ignored on patch" precedent).
// `team` is creation-time roster seeding too — there's no re-seed semantics
// in the spec's endpoint table for PATCH, so `update()` never reads it even
// though `UpdateCompanyDto` carries it (same precedent as
// `CommunitiesService.update` never reading `stewards`/`invites`).
export type UpdateCompanyInput = Partial<
  Omit<CreateCompanyInput, 'handle' | 'team'>
>;

export interface CompanyListQuery {
  page?: number;
}

export interface CreateReviewInput {
  title: string;
  stars: number;
  byline: string;
  body: string[];
}

@Injectable()
export class CompaniesService {
  constructor(
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    @InjectRepository(CompanyTeamMember)
    private readonly team: Repository<CompanyTeamMember>,
    @InjectRepository(CompanyReview)
    private readonly reviews: Repository<CompanyReview>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    // Open-role counts/lists for company cards + detail. Depends only on the
    // `Job` repository (via `CompanyOpenRolesModule`), never on `JobsService`,
    // so this direction of the old Companies <-> Jobs cycle is gone: no
    // `forwardRef` needed here (`JobsService` still injects `CompaniesService`,
    // but that edge is now one-directional).
    private readonly openRoles: CompanyOpenRolesService,
    // Read-only: a `hide_content`/`remove_content` takedown on a `company`
    // subject (keyed by the company slug — matching what the frontend report
    // control sends) withholds the company from every public read below.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // A company is reported (and taken down) under the `company` subject code,
  // keyed by the company slug. A hidden OR removed company vanishes from the
  // public list/detail/reviews for everyone — this service is a public surface
  // with no per-viewer staff role, so (like the directory) a takedown withholds
  // it entirely rather than rendering a tombstone. The owner still manages it
  // through the owner-gated write routes, which don't re-check this state.
  private static readonly SUBJECT_TYPE = 'company';

  async create(
    ownerId: string,
    dto: CreateCompanyInput,
  ): Promise<CompanyDetailDTO> {
    const saved = await this.createWithUniqueSlug(ownerId, dto);
    return this.buildDetail(saved, ownerId);
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // create landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505. A 23505
  // aborts the whole transaction (Postgres poisons it on any statement
  // error), so the retry has to re-run the *entire* transaction with a
  // freshly recomputed slug, not just the failed insert. Mirrors
  // `CommunitiesService.createWithUniqueRef`'s retry loop.
  private async createWithUniqueSlug(
    ownerId: string,
    dto: CreateCompanyInput,
  ): Promise<Company> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? dto.nameText, 'company'),
        (s) => this.companies.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const companiesRepo = manager.getRepository(Company);
          const teamRepo = manager.getRepository(CompanyTeamMember);

          const teamUserIds = await this.resolveTeamUserIds(
            manager.getRepository(Profile),
            dto.team ?? [],
            ownerId,
          );

          const company = await companiesRepo.save(
            companiesRepo.create({
              slug,
              nameText: dto.nameText,
              tagline: dto.tagline,
              about: dto.about,
              queerRun: dto.queerRun ?? false,
              queerLed: dto.queerLed ?? false,
              // Forced false regardless of input — verification is
              // admin-only and isn't even a field on `CreateCompanyDto`.
              verified: false,
              values: dto.values ?? [],
              info: dto.info ?? [],
              teamCount: teamUserIds.size,
              hiringContact: dto.hiringContact ?? null,
              work: normalizeWork(dto.work),
              ownerId,
            }),
          );

          if (teamUserIds.size) {
            await teamRepo.save(
              [...teamUserIds].map((userId) =>
                teamRepo.create({ companyId: company.id, userId }),
              ),
            );
          }

          return company;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry a fresh transaction
            // (the aborted one can't be resumed).
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique company slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved company or throws above.
    throw new ConflictException('Could not allocate a unique company slug');
  }

  async list(query: CompanyListQuery): Promise<Paginated<CompanyCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.companies
      .createQueryBuilder('c')
      .orderBy('c.created_at', 'DESC');
    this.excludeModeratedCompanies(qb);

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const ids = rows.map((c) => c.id);
      const [aggregates, openRoleCounts] = await Promise.all([
        this.reviewAggregatesForMany(ids),
        this.openRoles.openRoleCountsForMany(ids),
      ]);
      return rows.map((c) =>
        toCompanyCard(
          c,
          aggregates.get(c.id) ?? EMPTY_REVIEW_AGGREGATES,
          openRoleCounts.get(c.id) ?? 0,
        ),
      );
    });
  }

  async getBySlug(slug: string, viewerId: string): Promise<CompanyDetailDTO> {
    const company = await this.loadOr404(slug);
    await this.assertNotModerated(slug);
    return this.buildDetail(company, viewerId);
  }

  async update(
    slug: string,
    userId: string,
    dto: UpdateCompanyInput,
  ): Promise<CompanyDetailDTO> {
    const company = await this.loadOr404(slug);
    if (company.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can update this company');
    }

    Object.assign(company, {
      ...(dto.nameText !== undefined ? { nameText: dto.nameText } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.about !== undefined ? { about: dto.about } : {}),
      ...(dto.queerRun !== undefined ? { queerRun: dto.queerRun } : {}),
      ...(dto.queerLed !== undefined ? { queerLed: dto.queerLed } : {}),
      ...(dto.values !== undefined ? { values: dto.values } : {}),
      ...(dto.info !== undefined ? { info: dto.info } : {}),
      ...(dto.hiringContact !== undefined
        ? { hiringContact: dto.hiringContact }
        : {}),
      ...(dto.work !== undefined ? { work: normalizeWork(dto.work) } : {}),
    });

    const saved = await this.companies.save(company);
    return this.buildDetail(saved, userId);
  }

  async listReviews(
    slug: string,
    query: CompanyListQuery,
  ): Promise<Paginated<CompanyReviewDTO>> {
    const company = await this.loadOr404(slug);
    // A taken-down company's reviews are not publicly readable either — the
    // company itself has been withheld, so its sub-resources 404 too.
    await this.assertNotModerated(slug);
    const page = normalizePage(query.page);

    const qb = this.reviews
      .createQueryBuilder('r')
      .where('r.company_id = :companyId', { companyId: company.id })
      .orderBy('r.created_at', 'DESC');

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const refs = await new MemberLookup(this.profiles).byUserIds(
        rows.map((r) => r.authorId),
      );
      return rows.map((r) => toCompanyReview(r, refs.get(r.authorId) ?? null));
    });
  }

  // UNIQUE per (company, author) — a repeat review from the same member
  // surfaces as 23505, mapped to Conflict rather than a 500 (mirrors
  // `CommunitiesService.join`'s pending-request 23505 -> Conflict mapping).
  async createReview(
    slug: string,
    authorId: string,
    dto: CreateReviewInput,
  ): Promise<CompanyReviewDTO> {
    const company = await this.loadOr404(slug);

    try {
      const saved = await this.reviews.save(
        this.reviews.create({
          companyId: company.id,
          authorId,
          title: dto.title,
          stars: dto.stars,
          byline: dto.byline,
          body: dto.body,
        }),
      );
      const author = await this.memberRefFor(authorId);
      return toCompanyReview(saved, author);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('You have already reviewed this company');
      }
      throw err;
    }
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Company> {
    const company = await this.companies.findOne({ where: { slug } });
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  // Public reads treat a moderator takedown as a 404 — a hidden OR removed
  // company is withheld entirely (no tombstone on this surface). Deliberately
  // NOT called from the owner-gated write paths (`update`/`createReview`) so a
  // takedown never blocks the owner's own management, mirroring the directory.
  private async assertNotModerated(slug: string): Promise<void> {
    const state = await this.contentModeration.stateFor(
      CompaniesService.SUBJECT_TYPE,
      slug,
    );
    if (state.hidden || state.removed) {
      throw new NotFoundException('Company not found');
    }
  }

  // NOT EXISTS predicate dropping any company under a `company` takedown
  // (hidden OR removed) from a company query builder, in-query so the paginated
  // count stays consistent. Mirrors `DirectoryService.excludeModeratedListings`.
  private excludeModeratedCompanies(qb: SelectQueryBuilder<Company>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :companySubjectType
          AND "cm"."subject_id" = c.slug
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { companySubjectType: CompaniesService.SUBJECT_TYPE },
    );
  }

  // Resolves a single userId to a MemberRef for an actor who just created a
  // row (a miss here would mean a data-integrity bug — an authenticated
  // member without a profile — not a legitimate empty state). Mirrors
  // `CommunitiesService.memberRefFor`.
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async resolveTeamUserIds(
    profilesRepo: Repository<Profile>,
    slugs: string[],
    ownerId: string,
  ): Promise<Set<string>> {
    if (!slugs.length) return new Set();

    const lookup = new MemberLookup(profilesRepo);
    const idBySlug = await lookup.userIdsForSlugs(slugs);
    const seen = new Set<string>([ownerId]);
    const result = new Set<string>();

    for (const s of slugs) {
      const uid = idBySlug.get(s);
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        result.add(uid);
      }
    }
    return result;
  }

  private async buildDetail(
    company: Company,
    viewerId: string,
  ): Promise<CompanyDetailDTO> {
    const [aggregates, teamRows, ownerProfile, openRoles] = await Promise.all([
      this.reviewAggregatesFor(company.id),
      this.team.find({ where: { companyId: company.id } }),
      this.profiles.findOne({ where: { userId: company.ownerId } }),
      this.getOpenRoles(company),
    ]);

    const teamRefs = teamRows.length
      ? await new MemberLookup(this.profiles).byUserIds(
          teamRows.map((t) => t.userId),
        )
      : new Map<string, MemberRef>();
    const team = teamRows
      .map((t) => teamRefs.get(t.userId))
      .filter((ref): ref is MemberRef => !!ref);

    return toCompanyDetail(
      company,
      aggregates,
      team,
      toMemberRef(ownerProfile),
      company.ownerId === viewerId,
      openRoles,
    );
  }

  private async reviewAggregatesFor(
    companyId: string,
  ): Promise<CompanyReviewAggregates> {
    const map = await this.reviewAggregatesForMany([companyId]);
    return map.get(companyId) ?? EMPTY_REVIEW_AGGREGATES;
  }

  // Grouped pattern (mirrors `CommunitiesService.statsForMany`): one query
  // across the whole page/id-set instead of N+1 per-row lookups.
  private async reviewAggregatesForMany(
    companyIds: string[],
  ): Promise<Map<string, CompanyReviewAggregates>> {
    const result = new Map<string, CompanyReviewAggregates>(
      companyIds.map((id) => [id, EMPTY_REVIEW_AGGREGATES]),
    );
    if (!companyIds.length) return result;

    const rows = await this.reviews
      .createQueryBuilder('r')
      .select('r.company_id', 'companyId')
      .addSelect('r.stars', 'stars')
      .where('r.company_id IN (:...ids)', { ids: companyIds })
      .getRawMany<{ companyId: string; stars: number | string }>();

    const starsByCompany = new Map<string, number[]>(
      companyIds.map((id) => [id, []]),
    );
    for (const row of rows) {
      starsByCompany.get(row.companyId)?.push(Number(row.stars));
    }

    for (const [id, starsValues] of starsByCompany) {
      result.set(id, computeReviewAggregates(starsValues));
    }
    return result;
  }

  // Delegates to `CompanyOpenRolesService` (Job-repo only, no `JobsService`
  // dependency). We already hold the `Company` entity, so we pass its ref down
  // rather than have the open-roles service look the company up again — the
  // result is the same `JobCardDTO[]` for `CompanyDetailDTO.openRoles`.
  private async getOpenRoles(company: Company): Promise<JobCardDTO[]> {
    return this.openRoles.listForCompany(company.id, {
      slug: company.slug,
      nameText: company.nameText,
    });
  }

  // --- cross-domain accessors for JobsService ---
  // `JobsModule` never registers its own `Company`/`CompanyTeamMember`
  // repositories (see `.superpowers/sdd/spec-phaseB-companies-jobs.md`), so
  // it reaches company data only through these two methods on the already
  // circularly-wired `CompaniesService`.

  /**
   * Resolves a company by slug and confirms `userId` may post/manage jobs
   * under it — the owner or a `company_team_members` row. Returns `null`
   * when the slug doesn't exist (`JobsService` maps that to its own 404);
   * throws `ForbiddenException` when it exists but `userId` isn't
   * affiliated, keeping "what counts as affiliated" owned here rather than
   * duplicated in Jobs.
   */
  async getCompanyForJobPosting(
    slug: string,
    userId: string,
  ): Promise<(JobCompanyRef & { id: string }) | null> {
    const company = await this.companies.findOne({ where: { slug } });
    if (!company) return null;

    if (company.ownerId !== userId) {
      const isTeamMember = await this.team.exists({
        where: { companyId: company.id, userId },
      });
      if (!isTeamMember) {
        throw new ForbiddenException(
          'Only the company owner or team can post jobs for this company',
        );
      }
    }

    return { id: company.id, slug: company.slug, nameText: company.nameText };
  }

  /**
   * Batched company-id -> `{slug,nameText}` ref lookup (mirrors
   * `MemberLookup.byUserIds`'s shape) for `JobsService`'s list/detail views,
   * so a page of job cards resolves every embedded company ref in one query
   * instead of N+1.
   */
  async companyRefsByIds(
    companyIds: string[],
  ): Promise<Map<string, JobCompanyRef>> {
    const map = new Map<string, JobCompanyRef>();
    if (!companyIds.length) return map;

    const rows = await this.companies.find({
      where: { id: In(companyIds) },
      select: ['id', 'slug', 'nameText'],
    });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, nameText: row.nameText });
    }
    return map;
  }
}
