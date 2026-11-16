import type { EntityManager } from 'typeorm';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import {
  LEAD_ACCESS_STAFF_ROLE,
  type LeadAssigneeRefusalReason,
} from './leads.constants';

/**
 * Leads: who may be put in charge of a lead. One rule shared by the staff
 * picker (`LEAD_STAFF_ELIGIBLE_SQL` in its query), the assign route
 * (`leadStaffEligibility`, which reads the same columns one by one to name a
 * reason) and the access-loss hook (`LEAD_STAFF_HAS_ACCESS_SQL` inside its
 * DELETE). In every statement `"staff"` is the `users` alias.
 *
 * A suspension that lapsed stays `suspended` on the row until the member's
 * next request writes it back (`JwtStrategy.validate`), so that member reads
 * as suspended until then.
 */

/**
 * Has Leads access: the `users` row ("staff") is in the Admin tier or holds
 * the `LEAD_ACCESS_STAFF_ROLE` grant. The access-loss hook keeps assignments
 * while this holds.
 */
export const LEAD_STAFF_HAS_ACCESS_SQL = `("staff"."role" = 'admin' OR EXISTS (SELECT 1 FROM "user_staff_roles" "staff_grant" WHERE "staff_grant"."user_id" = "staff"."id" AND "staff_grant"."role" = '${LEAD_ACCESS_STAFF_ROLE}'))`;

/**
 * Eligible to be newly assigned: Leads access on an active, human account.
 * The picker filters with it; the assign route reads it column by column.
 */
export const LEAD_STAFF_ELIGIBLE_SQL = `("staff"."status" = 'active' AND "staff"."is_system" = false AND ${LEAD_STAFF_HAS_ACCESS_SQL})`;

/**
 * `$1` the user id. The person's status, role and house-account flag, only
 * when a profile backs them (the summary needs the slug and name). The share
 * lock makes a concurrent role change wait for the assignment to commit.
 */
export const LEAD_STAFF_ROW_SQL = `SELECT "staff"."status", "staff"."role", "staff"."is_system" FROM "users" "staff" INNER JOIN "profiles" "profile" ON "profile"."user_id" = "staff"."id" WHERE "staff"."id" = $1 FOR SHARE OF "staff"`;

/**
 * `$1` the user id. One row when the person holds the Leads grant. The share
 * lock makes a concurrent grant revoke wait for the assignment to commit, so
 * the access-loss hook always sees a committed assignment.
 */
export const LEAD_STAFF_GRANT_SQL = `SELECT 1 FROM "user_staff_roles" WHERE "user_id" = $1 AND "role" = '${LEAD_ACCESS_STAFF_ROLE}' FOR SHARE`;

/** What the assign route learns about one person. */
export type LeadStaffEligibility =
  | { kind: 'eligible' }
  | { kind: 'not_found' }
  | { kind: 'ineligible'; reason: LeadAssigneeRefusalReason };

/** The columns `LEAD_STAFF_ROW_SQL` answers. */
interface LeadStaffRow {
  status: UserStatus;
  role: UserRole;
  is_system: boolean;
}

/**
 * Reads one person for the assign route, inside the caller's transaction, and
 * decides in the contract's order: no person with a profile, the house
 * account, no Leads access, suspended, deactivated, then eligible. Both reads
 * always run so their share locks hold until the assignment commits.
 */
export async function leadStaffEligibility(
  manager: EntityManager,
  userId: string,
): Promise<LeadStaffEligibility> {
  const personRows: LeadStaffRow[] = await manager.query(LEAD_STAFF_ROW_SQL, [
    userId,
  ]);
  const grantRows: unknown[] = await manager.query(LEAD_STAFF_GRANT_SQL, [
    userId,
  ]);
  const person = personRows[0];
  if (!person) return { kind: 'not_found' };
  if (person.is_system) return { kind: 'ineligible', reason: 'no_access' };
  const hasLeadsAccess = person.role === UserRole.Admin || grantRows.length > 0;
  if (!hasLeadsAccess) return { kind: 'ineligible', reason: 'no_access' };
  if (person.status === UserStatus.Suspended) {
    return { kind: 'ineligible', reason: 'suspended' };
  }
  // Deactivated is the one status left besides active.
  if (person.status !== UserStatus.Active) {
    return { kind: 'ineligible', reason: 'deactivated' };
  }
  return { kind: 'eligible' };
}
