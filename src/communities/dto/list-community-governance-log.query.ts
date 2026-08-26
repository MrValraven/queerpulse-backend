import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { GovernanceLogAction } from '../entities/community-governance-log.entity';

/**
 * Query for `GET /communities/:slug/governance-log`: offset-paginated, newest
 * first, optionally narrowed to one action. Deliberately the same two fields,
 * in the same shape, as the admin-side
 * `ListAdminCommunityGovernanceLogQuery`
 * (`src/admin-communities/dto/list-community-governance-log.query.ts`), so the
 * community-facing reader and the platform-staff reader are paged and filtered
 * identically. Kept as its own class in this module rather than imported from
 * `admin-communities`, which the communities module does not depend on.
 *
 * Every field carries a validator because the global `ValidationPipe` runs
 * `whitelist` + `forbidNonWhitelisted`: an undecorated field would be stripped,
 * and any field not listed here is rejected outright.
 */
export class ListCommunityGovernanceLogQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsEnum(GovernanceLogAction)
  action?: GovernanceLogAction;
}
