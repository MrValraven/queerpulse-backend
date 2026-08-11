import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

// Admin `GET /admin/media` query — validated here rather than left to the
// service's own `Math.min(Math.max(...))` clamping (mirrors `AuditQueryDto`'s
// convention) so a malformed `limit` (e.g. `?limit=abc`) 400s instead of
// producing `Number.parseInt` -> `NaN` -> `Math.max(NaN, 1)` -> `NaN` ->
// `MaxKeys: NaN` reaching the S3 SDK as an uncaught 500. `prefix` is further
// validated to a known upload-kind allowlist by `AdminMediaService.resolvePrefix`.
export class AdminMediaListQueryDto {
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsString()
  continuationToken?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  // The "filter by uploader" view: list every object owned by this member
  // across all kinds. Validated as a UUID so a malformed value 400s at the
  // boundary rather than reaching an S3 `Prefix` of `<kind>//` (which would
  // silently list nothing) — and never as a path segment that could smuggle a
  // `/` into the prefix.
  @IsOptional()
  @IsUUID()
  uploaderId?: string;
}
