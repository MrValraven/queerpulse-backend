import type { EntityManager } from 'typeorm';
import { LEAD_STAFF_HAS_ACCESS_SQL } from './lead-staff-eligibility';

/**
 * Leads: `$1` the user id. Takes a key share lock on every lead the user is in
 * charge of, in id order, before the DELETE. An unassign holds its lead
 * `FOR UPDATE` and then deletes the same `lead_assignees` row, and the
 * `assignee_access_ended` insert needs a key share lock on the lead for its
 * foreign key. Without this read the hook would hold the assignment row while
 * waiting on the lead, and the unassign would hold the lead while waiting on
 * the row: a deadlock. Locking the leads first makes the hook wait for the
 * unassign to commit. A key share lock still lets plain updates to those
 * leads through; writes that lock the lead row wait for this transaction.
 */
export const LOCK_LEADS_OF_ASSIGNEE_SQL = `SELECT 1 FROM "leads" WHERE "id" IN (SELECT "lead_id" FROM "lead_assignees" WHERE "user_id" = $1) ORDER BY "id" FOR KEY SHARE`;

/**
 * Leads: `$1` the user id. Deletes their assignments only while they have no
 * Leads access, read in the same statement, and answers the lead ids.
 */
export const DROP_LEAD_ASSIGNMENTS_SQL = `DELETE FROM "lead_assignees" AS "la" WHERE "la"."user_id" = $1 AND NOT EXISTS (SELECT 1 FROM "users" "staff" WHERE "staff"."id" = $1 AND ${LEAD_STAFF_HAS_ACCESS_SQL}) RETURNING "la"."lead_id"`;

/**
 * Leads: `$1` the lead ids, `$2` the user id. One `assignee_access_ended`
 * entry per lead, with a null author.
 */
export const RECORD_LEAD_ACCESS_ENDED_SQL = `INSERT INTO "lead_entries" ("lead_id", "kind", "subject_user_id", "author_id") SELECT "ended"."lead_id", 'assignee_access_ended', $2::uuid, NULL FROM unnest($1::uuid[]) AS "ended"("lead_id")`;

/** One row `DROP_LEAD_ASSIGNMENTS_SQL` returns. */
interface DroppedAssignmentRow {
  lead_id: string;
}

/**
 * Leads: what losing Leads access ends. Every lead the user was in charge of
 * drops them, and each of those leads gains one `assignee_access_ended` entry
 * naming them, with a null author.
 *
 * `AdminMembersService.updateRole` calls it when a member leaves the Admin
 * tier, and `revokeStaffRole` when the `music_manager_producer` grant goes,
 * each inside its own transaction. The DELETE re-checks access in the same
 * statement, so a call for someone who still has access (a demoted admin
 * holding the grant, a revoke on an admin) changes nothing.
 *
 * It sends no notification and writes no audit row, and every statement is
 * raw SQL so `@UpdateDateColumn` never fires: `leads.updated_at` stays as it
 * was. A plain function over the caller's `EntityManager`, like
 * `forgetLeadLinkOfPersona`, so the admin members module calls it with no
 * repository of its own. Answers the ids of the leads the user left.
 */
export async function dropLeadAssignmentsOfUser(
  manager: EntityManager,
  userId: string,
): Promise<string[]> {
  await manager.query(LOCK_LEADS_OF_ASSIGNEE_SQL, [userId]);
  // TypeORM answers a Postgres `DELETE ... RETURNING` as `[rows, rowCount]`.
  const result: unknown = await manager.query(DROP_LEAD_ASSIGNMENTS_SQL, [
    userId,
  ]);
  const droppedRows =
    Array.isArray(result) && Array.isArray(result[0])
      ? (result[0] as DroppedAssignmentRow[])
      : [];
  const leadIds = droppedRows.map((droppedRow) => droppedRow.lead_id);
  if (leadIds.length > 0) {
    await manager.query(RECORD_LEAD_ACCESS_ENDED_SQL, [leadIds, userId]);
  }
  return leadIds;
}
