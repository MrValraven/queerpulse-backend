import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE, PAGE_SIZE } from '../../common/pagination';

/**
 * Deepest `offset` the audit history will honour, expressed the same way
 * `MAX_PAGE` is reasoned about in `common/pagination.ts`: `MAX_PAGE` pages of
 * `PAGE_SIZE` rows. `limit` was already capped and `offset` was not, which left
 * `?offset=2000000000` as an `OFFSET 2000000000` that Postgres has to walk row
 * by row before discarding everything it read. Free today at this table's size,
 * and a cheap way to pin a CPU once a busy platform has years of changes.
 *
 * Nobody reaches 200_000 audit rows deep by clicking through history, so no
 * real caller can hit this.
 */
const MAX_CHANGES_OFFSET = MAX_PAGE * PAGE_SIZE;

export class ListChangesQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_CHANGES_OFFSET)
  offset?: number;
}
