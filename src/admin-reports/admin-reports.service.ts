import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AdminCommunitiesService } from '../admin-communities/admin-communities.service';
import { reasonCodeToCategoryIndex } from '../admin-overview/admin-overview-response';
import { toCsvRow } from '../common/csv';
import { buildEmptyWeeklyBuckets, weekBucketIndex } from '../common/weekly-buckets';
import { AdminFinanceResponseDTO } from '../governance/admin-finance-response';
import { GovernanceFinanceService } from '../governance/governance-finance.service';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminReportsByTypeDTO,
  AdminReportsCommunityHealthDTO,
  AdminReportsGrowthDTO,
  DEFAULT_REPORT_WEEK_RANGE,
  ReportWeekRange,
  communityHealthRow,
} from './admin-reports-response';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read model behind the consolidated `/admin/reports` page: member growth
 * and reports-by-type over a real, caller-adjustable weekly range (ADM-17),
 * plus CSV export for both (ADM-19), plus the governance finance history and
 * a community-health snapshot reused (never recomputed) from their own
 * services.
 *
 * Deliberately narrower than `AdminOverviewService`: the Overview dashboard
 * keeps its own fixed 8/10-week windows unchanged (see that service's own
 * doc) — this is the ONLY place `weeks` is caller-adjustable, built on the
 * same bucketing math via the shared `../common/weekly-buckets` helpers so
 * the two never drift apart on how a "week" is defined.
 *
 * `getFinance` / `getCommunityHealth` do not recompute anything: they
 * delegate straight to `GovernanceFinanceService.getAdminFinances()` and
 * `AdminCommunitiesService.listCommunities()` — the same read models the
 * governance Finances tab and the Overview community-health tile already
 * use — so this page can never disagree with those sources of truth.
 * `getCommunityHealth` is a CURRENT snapshot only (`generatedAt`, no time
 * axis): there is no historical community-health table anywhere on the
 * platform, and building one (a new cron + storage subsystem) is out of
 * proportion for this pass.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    private readonly adminCommunities: AdminCommunitiesService,
    private readonly governanceFinance: GovernanceFinanceService,
  ) {}

  async getGrowth(
    weeks: ReportWeekRange = DEFAULT_REPORT_WEEK_RANGE,
  ): Promise<AdminReportsGrowthDTO> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - weeks * WEEK_MS);
    const profilesInWindow = await this.profiles.find({
      select: ['joinedAt'],
      where: { joinedAt: MoreThanOrEqual(windowStart) },
    });
    return {
      range: weeks,
      points: this.buildGrowthPoints(now, weeks, profilesInWindow),
    };
  }

  /** Same weekly join-cohort series as `getGrowth`, as a CSV attachment. */
  async getGrowthCsv(
    weeks: ReportWeekRange = DEFAULT_REPORT_WEEK_RANGE,
  ): Promise<string> {
    const { points } = await this.getGrowth(weeks);
    const table = [
      ['week_start', 'joined', 'spike'],
      ...points.map((point) => [
        point.at,
        String(point.joined),
        String(point.spike),
      ]),
    ];
    return table.map(toCsvRow).join('\n');
  }

  async getReportsByType(
    weeks: ReportWeekRange = DEFAULT_REPORT_WEEK_RANGE,
  ): Promise<AdminReportsByTypeDTO> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - weeks * WEEK_MS);
    const reportRows = await this.reports.find({
      where: { createdAt: MoreThanOrEqual(windowStart) },
      select: ['reasonCode', 'createdAt'],
    });
    return {
      range: weeks,
      weeks: this.buildReportsByTypeWeeks(now, weeks, reportRows),
    };
  }

  /** Same weekly reason-code buckets as `getReportsByType`, as a CSV
   *  attachment — one column per bucket (mirrors `reasonCodeToCategoryIndex`'s
   *  fixed 4-slot stacking order). */
  async getReportsByTypeCsv(
    weeks: ReportWeekRange = DEFAULT_REPORT_WEEK_RANGE,
  ): Promise<string> {
    const { weeks: weekRows } = await this.getReportsByType(weeks);
    const table = [
      ['week_start', 'outing', 'harassment', 'spam', 'other'],
      ...weekRows.map((week) => [week.weekStart, ...week.values.map(String)]),
    ];
    return table.map(toCsvRow).join('\n');
  }

  async getFinance(): Promise<AdminFinanceResponseDTO> {
    return this.governanceFinance.getAdminFinances();
  }

  async getCommunityHealth(): Promise<AdminReportsCommunityHealthDTO> {
    const { items } = await this.adminCommunities.listCommunities();
    const needingSupportCount = items.filter(
      (item) => item.needsSupport,
    ).length;
    const averageScore = items.length
      ? Math.round(
          items.reduce((sum, item) => sum + item.healthScore, 0) /
            items.length,
        )
      : null;
    return {
      generatedAt: new Date().toISOString(),
      averageScore,
      needingSupportCount,
      communities: items.map(communityHealthRow),
    };
  }

  private buildGrowthPoints(
    now: Date,
    weeks: number,
    profilesInWindow: Pick<Profile, 'joinedAt'>[],
  ): AdminReportsGrowthDTO['points'] {
    const buckets = buildEmptyWeeklyBuckets<number>(now, weeks, () => 0);
    for (const profile of profilesInWindow) {
      const bucketIndex = weekBucketIndex(now, profile.joinedAt, weeks);
      if (bucketIndex === null) continue;
      const bucket = buckets[bucketIndex];
      if (bucket === undefined) continue;
      bucket.value += 1;
    }

    let spikeBucketIndex = 0;
    for (let bucketIndex = 1; bucketIndex < buckets.length; bucketIndex += 1) {
      const candidateBucket = buckets[bucketIndex];
      const currentSpikeBucket = buckets[spikeBucketIndex];
      if (
        candidateBucket !== undefined &&
        currentSpikeBucket !== undefined &&
        candidateBucket.value > currentSpikeBucket.value
      ) {
        spikeBucketIndex = bucketIndex;
      }
    }
    const hasAnyGrowth = buckets.some((bucket) => bucket.value > 0);

    return buckets.map((bucket, index) => ({
      at: new Date(bucket.weekStartMs).toISOString(),
      joined: bucket.value,
      churned: null,
      spike: hasAnyGrowth && index === spikeBucketIndex,
    }));
  }

  private buildReportsByTypeWeeks(
    now: Date,
    weeks: number,
    reportRows: Pick<Report, 'reasonCode' | 'createdAt'>[],
  ): AdminReportsByTypeDTO['weeks'] {
    const buckets = buildEmptyWeeklyBuckets<[number, number, number, number]>(
      now,
      weeks,
      () => [0, 0, 0, 0],
    );
    for (const reportRow of reportRows) {
      const bucketIndex = weekBucketIndex(now, reportRow.createdAt, weeks);
      if (bucketIndex === null) continue;
      const categoryIndex = reasonCodeToCategoryIndex(reportRow.reasonCode);
      const bucket = buckets[bucketIndex];
      if (bucket === undefined) continue;
      bucket.value[categoryIndex] = (bucket.value[categoryIndex] ?? 0) + 1;
    }
    return buckets.map((bucket) => ({
      weekStart: new Date(bucket.weekStartMs).toISOString(),
      values: bucket.value,
    }));
  }
}
