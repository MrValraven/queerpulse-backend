import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { CommunitySpaceRequestStatus } from '../../communities/entities/community-space-request.entity';

export class ListAdminCommunitySpaceRequestsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(CommunitySpaceRequestStatus)
  status?: CommunitySpaceRequestStatus;
}
