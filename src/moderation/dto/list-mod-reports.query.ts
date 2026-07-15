import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  ReportSeverity,
  ReportSubjectType,
} from '../../reports/entities/report.entity';

const TABS = ['open', 'appeals', 'resolved'] as const;
export type ModReportsTab = (typeof TABS)[number];

const FILTERS = ['all', 'emergencies', 'mine'] as const;
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
