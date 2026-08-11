import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// The owner-facing follower / endorser lists are capped at 50 rows per page.
// Keep this in lockstep with `FOLLOWERS_LIST_CAP` / `ENDORSERS_LIST_CAP` in the
// two audience services (the services also clamp, defence-in-depth).
export const AUDIENCE_PAGE_MAX_LIMIT = 50;

// Shared `?page=&limit=` query for the owner-only follower and endorser list
// routes (`GET :id/followers`, `GET :id/endorsements`), so an owner can page
// through the whole audience rather than only ever seeing the first 50. The
// response still carries the full visible `count`.
export class ListAudienceQuery {
  // 1-based page index. `@Type` coerces the raw query string to a number before
  // the numeric validators run (query params arrive as strings even under the
  // global `transform: true` pipe).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIENCE_PAGE_MAX_LIMIT)
  limit?: number;
}
