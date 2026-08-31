import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * Page size used when the caller sends no `pageSize`. Equal to the previous
 * hard `DEFAULT_LIST_LIMIT` cap, so a client that sends neither `page` nor
 * `pageSize` sees exactly the response it saw before pagination existed.
 */
export const TITLE_PAGE_SIZE_DEFAULT = 200;

/** Hard ceiling on `pageSize`. */
export const TITLE_PAGE_SIZE_MAX = 200;

export class ListTitlesQuery {
  // ?all=true — moderators/admins only: include drafts/processing/failed.
  @IsOptional()
  @IsBooleanString()
  all?: string;

  /**
   * 1-based page (CNT-17). The list used to apply `take: DEFAULT_LIST_LIMIT`
   * with no `skip`, so once the catalog outgrew that cap older published
   * titles became unreachable from the list entirely (only by direct id), and
   * the moderator `all=true` view silently hid older drafts and failed
   * ingests. Paging makes the whole catalog reachable.
   *
   * The response deliberately stays a BARE ARRAY rather than the shared
   * `Paginated` envelope: every caller (`getTitles` in `cinema.api.ts` and the
   * admin console) reads it as an array, and this repository's backend work is
   * not permitted to change the frontend alongside it. A client detects the
   * last page by receiving fewer than `pageSize` items. Moving to the envelope
   * later is a coordinated frontend + backend change, not a silent one.
   */
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
  @Max(TITLE_PAGE_SIZE_MAX)
  pageSize?: number;
}
