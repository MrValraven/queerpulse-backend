import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

/**
 * `GET /admin/listing-drafts?page=` query. Shape copied from
 * `ListListingClaimsQuery`, including the `@Max(MAX_PAGE)` cap that stops a
 * deep-offset scan (ENG-49).
 */
export class ListAdminListingDraftsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
