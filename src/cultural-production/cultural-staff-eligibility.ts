import type { EntityManager } from 'typeorm';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import {
  CULTURAL_ACCESS_STAFF_ROLES,
  type CulturalAssigneeRefusalReason,
} from './cultural-production.constants';

/**
 * Cultural Production: who may be put on a task. One rule shared by the staff
 * picker (`CULTURAL_STAFF_ELIGIBLE_SQL` in its query), the assign route
 * (`culturalStaffEligibility`, which reads the same columns one by one to name
 * a reason) and the access-loss hook (`CULTURAL_STAFF_HAS_ACCESS_SQL` inside
 * its DELETE). In every statement `"staff"` is the `users` alias.
 *
 * A suspension that lapsed stays `suspended` on the row until the member's
 * next request writes it back (`JwtStrategy.validate`), so that member reads
 * as suspended until then.
 */

/** The grant role literals, quoted for an SQL `IN` list. */
const CULTURAL_GRANT_ROLE_LIST = CULTURAL_ACCESS_STAFF_ROLES.map(
  (staffRole) => `'${staffRole}'`,
).join(', ');

/**
 * Has Cultural Production access: the `users` row ("staff") is in the staff
 * tier (moderator or admin) or holds one of the two grants. The access-loss
 * hook keeps assignments while this holds.
 */
export const CULTURAL_STAFF_HAS_ACCESS_SQL = `("staff"."role" IN ('moderator', 'admin') OR EXISTS (SELECT 1 FROM "user_staff_roles" "staff_grant" WHERE "staff_grant"."user_id" = "staff"."id" AND "staff_grant"."role" IN (${CULTURAL_GRANT_ROLE_LIST})))`;

/**
 * Eligible to be newly assigned: access on an active, human account. The
 * picker filters with it; the assign route reads it column by column.
 */
export const CULTURAL_STAFF_ELIGIBLE_SQL = `("staff"."status" = 'active' AND "staff"."is_system" = false AND ${CULTURAL_STAFF_HAS_ACCESS_SQL})`;

/**
 * `$1` the user id. The status, role and house flag, only when a profile backs
 * them (the summary needs the slug and name). The share lock makes a
 * concurrent role change wait for the assignment to commit.
 */
export const CULTURAL_STAFF_ROW_SQL = `SELECT "staff"."status", "staff"."role", "staff"."is_system" FROM "users" "staff" INNER JOIN "profiles" "profile" ON "profile"."user_id" = "staff"."id" WHERE "staff"."id" = $1 FOR SHARE OF "staff"`;

/**
 * `$1` the user id. One row per grant that opens Cultural Production. The
 * share lock makes a concurrent grant revoke wait for the assignment to
 * commit, so the access-loss hook always sees a committed assignment.
 */
export const CULTURAL_STAFF_GRANT_SQL = `SELECT 1 FROM "user_staff_roles" WHERE "user_id" = $1 AND "role" IN (${CULTURAL_GRANT_ROLE_LIST}) FOR SHARE`;

/** What the assign route learns about one person. */
export type CulturalStaffEligibility =
  | { kind: 'eligible' }
  | { kind: 'not_found' }
  | { kind: 'ineligible'; reason: CulturalAssigneeRefusalReason };

/** The columns `CULTURAL_STAFF_ROW_SQL` answers. */
interface CulturalStaffRow {
  status: UserStatus;
  role: UserRole;
  is_system: boolean;
}

/**
 * Reads one person for the assign route, inside the caller's transaction, and
 * decides in the contract's order: no person with a profile, the house
 * account, no Cultural Production access, suspended, deactivated, then
 * eligible. Both reads always run so their share locks hold until the
 * assignment commits.
 */
export async function culturalStaffEligibility(
  manager: EntityManager,
  userId: string,
): Promise<CulturalStaffEligibility> {
  const personRows: CulturalStaffRow[] = await manager.query(
    CULTURAL_STAFF_ROW_SQL,
    [userId],
  );
  const grantRows: unknown[] = await manager.query(CULTURAL_STAFF_GRANT_SQL, [
    userId,
  ]);
  const person = personRows[0];
  if (!person) return { kind: 'not_found' };
  if (person.is_system) return { kind: 'ineligible', reason: 'no_access' };
  const isStaffTier =
    person.role === UserRole.Moderator || person.role === UserRole.Admin;
  const hasCulturalAccess = isStaffTier || grantRows.length > 0;
  if (!hasCulturalAccess) return { kind: 'ineligible', reason: 'no_access' };
  if (person.status === UserStatus.Suspended) {
    return { kind: 'ineligible', reason: 'suspended' };
  }
  // Deactivated is the one status left besides active.
  if (person.status !== UserStatus.Active) {
    return { kind: 'ineligible', reason: 'deactivated' };
  }
  return { kind: 'eligible' };
}
