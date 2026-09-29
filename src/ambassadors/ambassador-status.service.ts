import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { BADGED_STAFF_ROLE_IDS } from '../users/staff-roles.registry';
import {
  AMBASSADOR_INVITE_BONUS,
  AmbassadorFocusArea,
  isAmbassadorFocusArea,
} from './ambassador-focus-areas';
import { PlatformAmbassadorRowDTO } from './ambassador-response';
import { Ambassador } from './entities/ambassador.entity';

/** The account tiers that wear a staff badge by themselves. */
const STAFF_ACCOUNT_ROLES: readonly UserRole[] = [
  UserRole.Moderator,
  UserRole.Admin,
];

/** Bound parameters for `notBadgedStaffClause`; set them on the same builder. */
export const NOT_BADGED_STAFF_PARAMETERS = {
  staffAccountRoles: [...STAFF_ACCOUNT_ROLES],
  badgedStaffRoles: [...BADGED_STAFF_ROLE_IDS],
};

/**
 * SQL predicate that holds when the member whose id sits in `userIdColumn`
 * wears no staff badge: their account tier is neither moderator nor admin, and
 * they hold no additive staff grant that earns a badge (see
 * BADGED_STAFF_ROLE_IDS). Staff always win: a badged member never counts as a
 * visible ambassador, on the roster, the invitee line or the directory filter.
 *
 * `userIdColumn` is trusted SQL the caller writes by hand (a quoted alias and
 * column). Every value is a bound parameter from NOT_BADGED_STAFF_PARAMETERS.
 * The grant check is dropped when no staff role earns a badge, because `IN ()`
 * is not valid SQL.
 */
export function notBadgedStaffClause(userIdColumn: string): string {
  const accountTierClause = `NOT EXISTS (
    SELECT 1 FROM "users" "staffAccount"
    WHERE "staffAccount"."id" = ${userIdColumn}
      AND "staffAccount"."role" IN (:...staffAccountRoles)
  )`;
  if (!BADGED_STAFF_ROLE_IDS.length) return accountTierClause;
  return `${accountTierClause} AND NOT EXISTS (
    SELECT 1 FROM "user_staff_roles" "staffGrant"
    WHERE "staffGrant"."user_id" = ${userIdColumn}
      AND "staffGrant"."role" IN (:...badgedStaffRoles)
  )`;
}

/**
 * The cheap reads about ambassador status: whether a member has an active
 * grant, whether their tag is visible, and the invite bonus that follows.
 * Writes (grant/revoke/admin CRUD) live in the sibling `AmbassadorsModule`.
 */
@Injectable()
export class AmbassadorStatusService {
  constructor(
    @InjectRepository(Ambassador)
    private readonly ambassadors: Repository<Ambassador>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  findActive(userId: string): Promise<Ambassador | null> {
    return this.ambassadors.findOne({ where: { userId, revokedAt: IsNull() } });
  }

  async getInviteBonus(userId: string): Promise<number> {
    return (await this.findActive(userId)) ? AMBASSADOR_INVITE_BONUS : 0;
  }

  /**
   * Whether the invitee welcome line may name this member as an ambassador:
   * an active grant, a visible tag, and no staff badge (staff always win).
   */
  async isVisibleAmbassador(userId: string): Promise<boolean> {
    if (!(await this.findActive(userId))) return false;
    return this.profiles
      .createQueryBuilder('profile')
      .where('profile.userId = :userId', { userId })
      .andWhere('profile.isAmbassadorTagVisible = true')
      .andWhere(
        notBadgedStaffClause('"profile"."user_id"'),
        NOT_BADGED_STAFF_PARAMETERS,
      )
      .getExists();
  }

  /**
   * Every active, visible ambassador on an active account, newest grant
   * first. Uncapped on purpose (ENG-458): this list feeds the tag map, so a
   * cap would strip the tag from whoever fell past it. Rows are three short
   * fields and grants are made by hand.
   */
  async listVisibleRoster(): Promise<PlatformAmbassadorRowDTO[]> {
    const rows = await this.ambassadors
      .createQueryBuilder('ambassador')
      .innerJoin('ambassador.user', 'user')
      .innerJoin('user.profile', 'profile')
      .select([
        'ambassador.focusArea AS "focusArea"',
        'ambassador.grantedAt AS "grantedAt"',
        'profile.slug AS "slug"',
      ])
      .where('ambassador.revokedAt IS NULL')
      .andWhere('user.status = :activeStatus', {
        activeStatus: UserStatus.Active,
      })
      .andWhere('profile.isAmbassadorTagVisible = true')
      // Staff always win: a badged member stays off the ambassador roster.
      .andWhere(
        notBadgedStaffClause('"ambassador"."user_id"'),
        NOT_BADGED_STAFF_PARAMETERS,
      )
      .orderBy('ambassador.grantedAt', 'DESC')
      .getRawMany<{
        focusArea: string;
        grantedAt: Date;
        slug: string | null;
      }>();
    return rows
      .filter((row) => row.slug && isAmbassadorFocusArea(row.focusArea))
      .map((row) => ({
        slug: row.slug as string,
        focusArea: row.focusArea as AmbassadorFocusArea,
        since: new Date(row.grantedAt).toISOString(),
      }));
  }
}
