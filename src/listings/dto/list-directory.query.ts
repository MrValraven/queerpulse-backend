import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * Optional server-side filters for the public directory grid. The frontend
 * also filters client-side (it renders a "showing X of Y" count over the full
 * set), so both are honored: omitting these returns every live listing.
 */
export class ListDirectoryQuery {
  /** Category slug — matches when present in the listing's `cats`. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cat?: string;

  /** Free-text search over name / blurb / hood. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  /**
   * When `'verified'`, restricts the grid to listings whose
   * `safeSpaceStatus` is `verified`. Omitting it returns every live listing,
   * with verified rows boosted first in the default order.
   */
  @IsOptional()
  @IsIn(['verified'])
  safe?: 'verified';

  /**
   * Opt into the paginated `Paginated<DirectoryCardDTO>` envelope
   * (`DirectoryService.listDirectory`), `PAGE_SIZE`-per-page instead of the
   * bare, `DEFAULT_LIST_LIMIT`-capped array. Omitting `page` entirely keeps
   * the original bare-array response — the frontend's whole-catalog callers
   * (venue picker, @mention suggestions, "related places") rely on that exact
   * shape and don't paginate; only the `/local/directory` grid opts in by
   * sending `page` (see `directory.api.ts#getDirectoryPage`).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
