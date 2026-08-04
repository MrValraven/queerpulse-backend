import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Job, JobStatus } from './entities/job.entity';
import { JobCardDTO, JobCompanyRef, toJobCard } from './job-response';

// A job is taken down under the `job` subject, keyed by slug (see
// `JobsService`). A company's open-roles surface is a public company page with
// no per-viewer staff role, so a hidden OR removed job is dropped for everyone
// — mirroring `DirectoryService`'s public read filtering.
const JOB_SUBJECT_TYPE = 'job';

/**
 * Read-only view over a company's *open* roles, backing
 * `CompanyCardDTO.openRolesCount` and `CompanyDetailDTO.openRoles`.
 *
 * Deliberately depends only on the `Job` repository — never on
 * `CompaniesService` — so `CompaniesService` can consume it *without*
 * re-introducing the Companies <-> Jobs provider cycle (mirrors
 * `AffiliationService`, which reads `Company`/`CompanyTeamMember` directly
 * rather than importing `CompaniesModule`). The caller (`CompaniesService`,
 * which already holds the `Company` entity) supplies the embedded company
 * ref, so this service never needs to look a company up itself.
 */
@Injectable()
export class CompanyOpenRolesService {
  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * Batched open-role counts for a set of companies: a single
   * `COUNT(*) ... WHERE status = Open AND company_id IN (...) GROUP BY
   * company_id`, instead of one per-company job-list query (the former N+1 in
   * `CompaniesService.list`). Mirrors
   * `CompaniesService.reviewAggregatesForMany`'s grouped pattern. Every
   * requested id is present in the result — companies with no open roles are
   * seeded to `0`.
   */
  async openRoleCountsForMany(
    companyIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>(companyIds.map((id) => [id, 0]));
    if (!companyIds.length) return result;

    const rows = await this.jobs
      .createQueryBuilder('j')
      .select('j.company_id', 'companyId')
      .addSelect('COUNT(*)', 'count')
      .where('j.status = :status', { status: JobStatus.Open })
      .andWhere('j.company_id IN (:...ids)', { ids: companyIds })
      // Don't count a moderator-taken-down job toward a company's open-roles
      // count — the count must match the (also-filtered) list below.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cmj"
          WHERE "cmj"."subject_type" = :jobSubjectType
            AND "cmj"."subject_id" = j.slug
            AND ("cmj"."hidden_at" IS NOT NULL OR "cmj"."removed_at" IS NOT NULL)
        )`,
        { jobSubjectType: JOB_SUBJECT_TYPE },
      )
      .groupBy('j.company_id')
      .getRawMany<{ companyId: string; count: string }>();

    for (const row of rows) {
      result.set(row.companyId, Number(row.count));
    }
    return result;
  }

  /**
   * A single company's open roles as `JobCardDTO[]`, newest first — what
   * `CompanyDetailDTO.openRoles` renders. The caller passes the already-loaded
   * company ref (it holds the `Company` entity), so no company lookup happens
   * here. Returns `[]` (never touching the ref) when the company has no open
   * roles.
   */
  async listForCompany(
    companyId: string,
    companyRef: JobCompanyRef | null,
  ): Promise<JobCardDTO[]> {
    const rows = await this.jobs.find({
      where: { companyId, status: JobStatus.Open },
      order: { createdAt: 'DESC' },
    });
    // Drop any job carrying a `job` takedown so a removed role never renders on
    // the public company page (post-filter mirrors
    // `DirectoryService.dropModeratedListings`, keyed by slug).
    const visible = await this.dropModeratedJobs(rows);
    return visible.map((job) => toJobCard(job, companyRef));
  }

  private async dropModeratedJobs(rows: Job[]): Promise<Job[]> {
    if (!rows.length) return rows;
    const states = await this.contentModeration.statesFor(
      JOB_SUBJECT_TYPE,
      rows.map((job) => job.slug),
    );
    return rows.filter((job) => {
      const state = states.get(job.slug);
      return !state || (!state.hidden && !state.removed);
    });
  }
}
