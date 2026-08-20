import { AdminCommunityCardDTO } from '../admin-communities/admin-communities-response';

/**
 * Shapes the consolidated `/admin/reports` page renders (ADM-17 real
 * adjustable date ranges, ADM-19 CSV export). Pure DTO + mapper helpers only
 * — no DB access, no Nest decorators — mirroring
 * `../admin-overview/admin-overview-response.ts`.
 */

/** Allowed `weeks` presets for the growth / reports-by-type trend charts —
 *  an allowlist rather than an arbitrary bounded integer, so a caller can
 *  never force an unbounded or oddball scan window. */
export const REPORT_WEEK_RANGES = [4, 8, 12, 26] as const;
export type ReportWeekRange = (typeof REPORT_WEEK_RANGES)[number];
export const DEFAULT_REPORT_WEEK_RANGE: ReportWeekRange = 8;

export interface AdminReportsGrowthPoint {
  at: string;
  joined: number;
  /** Always null — there is no churn/leave data anywhere on the platform yet
   *  (mirrors `AdminOverviewDTO.memberGrowth.points[].churned`). Kept in the
   *  shape so the frontend renders "not measured yet" rather than a
   *  fabricated number. */
  churned: null;
  spike: boolean;
}

export interface AdminReportsGrowthDTO {
  range: ReportWeekRange;
  points: AdminReportsGrowthPoint[];
}

export interface AdminReportsByTypeWeek {
  weekStart: string;
  /** [outing, harassment, spam, other] — same stacking order as
   *  `AdminOverviewDTO.reportsByType`. */
  values: [number, number, number, number];
}

export interface AdminReportsByTypeDTO {
  range: ReportWeekRange;
  weeks: AdminReportsByTypeWeek[];
}

export interface AdminReportsCommunityHealthRow {
  slug: string;
  name: string;
  healthScore: number;
  activityLabel: AdminCommunityCardDTO['activityLabel'];
  memberCount: number;
  openReportCount: number;
  needsSupport: boolean;
}

/**
 * A CURRENT snapshot only — there is no historical community-health table
 * anywhere on the platform (no cron writes one), so `generatedAt` is the only
 * time axis this ever gets. The frontend must label this "as of now", never
 * imply a trend.
 */
export interface AdminReportsCommunityHealthDTO {
  generatedAt: string;
  averageScore: number | null;
  needingSupportCount: number;
  communities: AdminReportsCommunityHealthRow[];
}

/** Projects `AdminCommunitiesService.listCommunities()`'s per-community card
 *  down to the fields this report's table needs — never re-derives the
 *  health score itself. */
export function communityHealthRow(
  card: AdminCommunityCardDTO,
): AdminReportsCommunityHealthRow {
  return {
    slug: card.slug,
    name: card.name,
    healthScore: card.healthScore,
    activityLabel: card.activityLabel,
    memberCount: card.memberCount,
    openReportCount: card.openReportCount,
    needsSupport: card.needsSupport,
  };
}
