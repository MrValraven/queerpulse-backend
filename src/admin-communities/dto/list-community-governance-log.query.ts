import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { GovernanceLogAction } from '../../communities/entities/community-governance-log.entity';

/**
 * Query for `GET /admin/communities/:slug/governance-log`: offset-paginated,
 * newest first, optionally narrowed to one action. Mirrors
 * `ListAdminCommunityTagRequestsQuery`.
 */
export class ListAdminCommunityGovernanceLogQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @IsEnum(GovernanceLogAction)
  action?: GovernanceLogAction;
}
