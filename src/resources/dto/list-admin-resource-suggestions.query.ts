import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { ResourceListingCategory } from '../entities/resource-listing.entity';
import { ResourceSuggestionStatus } from '../entities/resource-suggestion.entity';

/** Query for the admin resource-suggestion review queue: paginated,
 *  newest-first, optionally narrowed to a category and/or a status. */
export class ListAdminResourceSuggestionsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(ResourceListingCategory)
  category?: ResourceListingCategory;

  @IsOptional()
  @IsEnum(ResourceSuggestionStatus)
  status?: ResourceSuggestionStatus;
}
