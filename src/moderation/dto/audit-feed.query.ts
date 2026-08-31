import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

const RANGES = ['today', 'week', 'quarter'] as const;
export type AuditRange = (typeof RANGES)[number];

// `GET /mod/audit` query — the global, cross-report moderation audit feed
// backing the admin governance "Audit" tab. Unlike `AuditLogQuery`
// (`./audit-log.query.ts`, `GET /mod/reports/audit?reportId=`), this is not
// scoped to a single report: every `mod_audit_logs` row is eligible,
// including the report-less ones (e.g. `suspension_lifted`) that
// `auditTrail` can never surface.
export class AuditFeedQuery {
  // Filters to one acting moderator (`ModAuditLog.actorId`).
  @IsOptional()
  @IsUUID()
  moderator?: string;

  // Filters to one exact `ModAuditLog.action` value.
  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsIn(RANGES)
  range?: AuditRange;

  // Free-text search against `ModAuditLog.note`.
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}
