import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Cards "Made together" returns when the client sends no `limit`. */
export const MADE_TOGETHER_DEFAULT_LIMIT = 8;
/** The most cards one request may ask for. */
export const MADE_TOGETHER_MAX_LIMIT = 12;

/**
 * `?limit=` for `GET /subprofiles/made-together`. Bounded so a hostile caller
 * cannot widen what one request returns; the window the service scans is a
 * fixed constant and does not grow with it.
 */
export class ListMadeTogetherQuery {
  // `@Type` coerces the raw query string to a number before the numeric
  // validators run (query params arrive as strings even under the global
  // `transform: true` pipe).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MADE_TOGETHER_MAX_LIMIT)
  limit?: number;
}
