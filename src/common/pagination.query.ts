import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Shared `?limit=&offset=` query for the offset-paginated list endpoints that
 * return a bare array rather than a `Paginated<T>` envelope (see
 * `./pagination.ts` for the envelope helpers). Bounds them so a caller can page
 * through instead of pulling every row; `limit` is capped so a request can't
 * ask for an unbounded page.
 *
 * One class app-wide rather than a per-module copy: Swagger keys its schema
 * registry by class name, so two identically-named DTOs in different modules
 * collide there even when — as these two were — they are byte-identical.
 */
export class PaginationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
