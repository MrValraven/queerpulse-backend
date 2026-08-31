import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * `GET /admin/listings/claims?page=` query (ENG-41).
 *
 * The pending listing-claim review queue used to answer with a flat array
 * capped at `DEFAULT_LIST_LIMIT`. Oldest-first plus a hard cap meant the claims
 * that fell off the end were the newest ones filed, and nothing in the response
 * told a moderator any were missing. It now answers with the repo's
 * `Paginated<T>` envelope; this is the page a moderator walks with.
 *
 * Shape copied from `ListMyListingsQuery`, including the `@Max(MAX_PAGE)` cap
 * that stops a deep-offset scan (ENG-49).
 */
export class ListListingClaimsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
