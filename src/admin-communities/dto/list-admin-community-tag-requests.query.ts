import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { CommunityTagRequestStatus } from '../../communities/entities/community-tag-request.entity';

/** Query for the admin "suggest a tag" review queue: paginated, newest-first,
 *  optionally narrowed to a status. Mirrors
 *  `ListAdminResourceSuggestionsQuery`. */
export class ListAdminCommunityTagRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(CommunityTagRequestStatus)
  status?: CommunityTagRequestStatus;
}
