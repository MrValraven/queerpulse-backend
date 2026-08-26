import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
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
  page?: number;

  @IsOptional()
  @IsEnum(GovernanceLogAction)
  action?: GovernanceLogAction;
}
