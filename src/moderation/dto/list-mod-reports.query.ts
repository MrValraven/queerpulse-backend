import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  ReportSeverity,
  ReportSubjectType,
} from '../../reports/entities/report.entity';

const TABS = ['open', 'appeals', 'resolved'] as const;
export type ModReportsTab = (typeof TABS)[number];

/**
 * `overdue` and `surge` are the two TS-06 triage filters.
 *
 * `overdue` is "the response window has already closed": `sla_due_at` is in
 * the past and the report is still unresolved. `surge` is "several different
 * people are reporting the same thing", which is the shape of both a genuine
 * emergency and a brigade, and the queue could not tell either of them from
 * thirty independent complaints. See `ModerationService.applySurgeFilter` for
 * the thresholds, which are the ones `CommunityAutoFreezeService` already
 * uses one layer down.
 */
const FILTERS = ['all', 'emergencies', 'mine', 'overdue', 'surge'] as const;
export type ModReportsFilter = (typeof FILTERS)[number];

const SORTS = ['priority', 'age'] as const;
export type ModReportsSort = (typeof SORTS)[number];

// `GET /mod/reports` query — matches `ModReportsParams` in
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly (C4). `tab`
// is mapped to `status` server-side (see `ModerationService.applyTabFilter`);
// `status` itself is never sent by the frontend and is intentionally not
// accepted here.
export class ListModReportsQuery {
  @IsOptional()
  @IsIn(TABS)
  tab?: ModReportsTab;

  @IsOptional()
  @IsIn(FILTERS)
  filter?: ModReportsFilter;

  @IsOptional()
  @IsIn(Object.values(ReportSeverity))
  severity?: ReportSeverity;

  @IsOptional()
  @IsIn(Object.values(ReportSubjectType))
  subjectType?: ReportSubjectType;

  /**
   * Filters to reports carrying this exact `subjectId` string (COM-6) — the
   * same literal value `ModerationService.describeReported`/
   * `priorReportCountsBySubject` already group "prior reports" by, so a
   * report's `priorReports` count and this filter can never disagree about
   * what counts as "another report about the same subject". Powers the
   * moderation queue's "view this member's report history" click-through;
   * combine with `subjectType` for an unambiguous match.
   */
  @IsOptional()
  @IsString()
  subjectId?: string;

  /**
   * Narrows the queue to reports that came from ONE community, by its slug
   * (TS-14) — the same value `ModReportDTO.community` reports back, so a
   * moderator can click a row's community chip and see everything else from
   * that room.
   *
   * Attribution follows `admin-communities/community-report-scope.ts` exactly:
   * a `community` report (the slug itself), a `post` or `reply` whose content
   * belongs to that community, and a `gathering` hosted inside it. A member,
   * message or venue report is NOT attributed to a community by either
   * surface, so this filter never invents one for them.
   */
  @IsOptional()
  @IsString()
  community?: string;

  @IsOptional()
  @IsIn(SORTS)
  sort?: ModReportsSort;

  @IsOptional()
  @IsString()
  cursor?: string;

  // Not part of the frontend contract (it never sends `limit`) but kept as an
  // optional, server-side-only knob — whitelist only rejects fields the
  // *client* sends that aren't declared here, not the reverse.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
