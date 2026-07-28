import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { JobCardDTO, JobCompanyRef, toJobCard } from './job-response';

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
    return rows.map((job) => toJobCard(job, companyRef));
  }
}
