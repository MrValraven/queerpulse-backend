import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { CommunityTagRequestStatus } from '../../communities/entities/community-tag-request.entity';

/** Query for the admin "suggest a tag" review queue: paginated, newest-first,
 *  optionally narrowed to a status. Mirrors
 *  `ListAdminResourceSuggestionsQuery`. */
export class ListAdminCommunityTagRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(CommunityTagRequestStatus)
  status?: CommunityTagRequestStatus;
}
