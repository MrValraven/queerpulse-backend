import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import {
  CREATOR_DRAFT_KINDS,
  CreatorDraftKind,
} from '../creator-drafts.constants';

/**
 * `GET /admin/creator-drafts?kind=&page=` query. Both are optional. `page`
 * takes the shape of `ListAdminListingDraftsQuery`, including the
 * `@Max(MAX_PAGE)` cap that stops a deep-offset scan (ENG-49); `@Min(1)` keeps
 * the OFFSET at zero or above.
 */
export class ListAdminCreatorDraftsQuery {
  @IsOptional()
  @IsIn(CREATOR_DRAFT_KINDS)
  kind?: CreatorDraftKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
