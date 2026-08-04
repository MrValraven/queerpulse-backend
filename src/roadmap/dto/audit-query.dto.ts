import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

// Admin `GET /admin/roadmap/audit` query — cursor-paginated by `createdAt`
// (see `RoadmapAdminService.getAudit`'s doc for why `before` is a timestamp
// cursor, not an offset). Both bounds are validated here rather than left to
// the service's own `Math.min(Math.max(...))`/`new Date(...)` clamping so a
// malformed `before` (e.g. a non-ISO string) 400s instead of producing an
// `Invalid Date` that would otherwise silently match nothing (or, worse,
// everything) — matches `GetMessagesQuery`'s `before` convention.
export class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  before?: string;
}
