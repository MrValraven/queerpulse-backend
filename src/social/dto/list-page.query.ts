import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * Shared `?page=` query for `GET /blocks` and `GET /mutes`. Matches
 * `social.api.ts`'s `getBlocks(page?: number)` / `getMutes(page?: number)` —
 * a plain 1-based page number, not an opaque cursor (see the page-number vs.
 * cursor discrepancy note in the module report).
 */
export class ListPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
