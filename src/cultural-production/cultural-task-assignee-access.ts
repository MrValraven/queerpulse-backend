import type { EntityManager } from 'typeorm';
import { CULTURAL_STAFF_HAS_ACCESS_SQL } from './cultural-staff-eligibility';

/**
 * Cultural Production: `$1` the user id. Deletes their task assignments only
 * while they have no Cultural Production access, read in the same statement,
 * and answers the task ids.
 */
export const DROP_CULTURAL_TASK_ASSIGNMENTS_SQL = `DELETE FROM "cultural_task_assignees" AS "assignment" WHERE "assignment"."user_id" = $1 AND NOT EXISTS (SELECT 1 FROM "users" "staff" WHERE "staff"."id" = $1 AND ${CULTURAL_STAFF_HAS_ACCESS_SQL}) RETURNING "assignment"."task_id"`;

/** One row `DROP_CULTURAL_TASK_ASSIGNMENTS_SQL` returns. */
interface DroppedTaskAssignmentRow {
  task_id: string;
}

/**
 * Cultural Production: what losing access ends. Every task the user was
 * assigned to drops them, in one statement inside the caller's transaction.
 *
 * `AdminMembersService.updateRole` calls it when a member leaves the staff
 * tier, and `revokeStaffRole` when `cultural_producer` or
 * `music_manager_producer` goes below the staff tier. The DELETE re-checks
 * access in the same statement, so a call for someone who still has access
 * (the other grant remains, or the person is still in the staff tier) changes
 * nothing.
 *
 * There is no lock read before the DELETE: this hook inserts nothing, so it
 * never needs a key share lock on `cultural_tasks`, and an unassign (task
 * `FOR UPDATE`, then the assignee row) and this DELETE (the assignee row only)
 * cannot wait on each other in a cycle. It sends no notification, writes no
 * audit row and leaves `cultural_tasks.updated_at` as it was. Backers and
 * comments stay. Answers the ids of the tasks the user left.
 */
export async function dropCulturalTaskAssignmentsOfUser(
  manager: EntityManager,
  userId: string,
): Promise<string[]> {
  // TypeORM answers a Postgres `DELETE ... RETURNING` as `[rows, rowCount]`.
  const result: unknown = await manager.query(
    DROP_CULTURAL_TASK_ASSIGNMENTS_SQL,
    [userId],
  );
  const droppedRows =
    Array.isArray(result) && Array.isArray(result[0])
      ? (result[0] as DroppedTaskAssignmentRow[])
      : [];
  return droppedRows.map((droppedRow) => droppedRow.task_id);
}
