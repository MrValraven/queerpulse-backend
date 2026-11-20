import type { EntityManager } from 'typeorm';
import { CULTURAL_STAFF_HAS_ACCESS_SQL } from './cultural-staff-eligibility';
import {
  DROP_CULTURAL_TASK_ASSIGNMENTS_SQL,
  dropCulturalTaskAssignmentsOfUser,
} from './cultural-task-assignee-access';

const USER_ID = 'e3000000-0000-4000-8000-000000000001';
const TASK_ID = 'e3000000-0000-4000-8000-000000000002';
const OTHER_TASK_ID = 'e3000000-0000-4000-8000-000000000003';

describe('dropCulturalTaskAssignmentsOfUser', () => {
  let manager: EntityManager & { query: jest.Mock };

  beforeEach(() => {
    manager = { query: jest.fn() } as unknown as EntityManager & {
      query: jest.Mock;
    };
  });

  it('re-checks access inside the delete', () => {
    expect(DROP_CULTURAL_TASK_ASSIGNMENTS_SQL).toBe(
      `DELETE FROM "cultural_task_assignees" AS "assignment" WHERE "assignment"."user_id" = $1 AND NOT EXISTS (SELECT 1 FROM "users" "staff" WHERE "staff"."id" = $1 AND ${CULTURAL_STAFF_HAS_ACCESS_SQL}) RETURNING "assignment"."task_id"`,
    );
    expect(DROP_CULTURAL_TASK_ASSIGNMENTS_SQL).toContain('NOT EXISTS');
    expect(DROP_CULTURAL_TASK_ASSIGNMENTS_SQL).toContain(
      CULTURAL_STAFF_HAS_ACCESS_SQL,
    );
  });

  it('reads task ids from the [rows, rowCount] answer', async () => {
    manager.query.mockResolvedValueOnce([
      [{ task_id: TASK_ID }, { task_id: OTHER_TASK_ID }],
      2,
    ]);
    expect(await dropCulturalTaskAssignmentsOfUser(manager, USER_ID)).toEqual([
      TASK_ID,
      OTHER_TASK_ID,
    ]);
  });

  it('reads any other answer as no task', async () => {
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([{ task_id: TASK_ID }])
      .mockResolvedValueOnce({ affected: 1 });
    expect(await dropCulturalTaskAssignmentsOfUser(manager, USER_ID)).toEqual(
      [],
    );
    expect(await dropCulturalTaskAssignmentsOfUser(manager, USER_ID)).toEqual(
      [],
    );
    expect(await dropCulturalTaskAssignmentsOfUser(manager, USER_ID)).toEqual(
      [],
    );
    expect(await dropCulturalTaskAssignmentsOfUser(manager, USER_ID)).toEqual(
      [],
    );
  });

  it('runs one statement and inserts nothing', async () => {
    manager.query.mockResolvedValueOnce([[{ task_id: TASK_ID }], 1]);
    await dropCulturalTaskAssignmentsOfUser(manager, USER_ID);
    expect(manager.query.mock.calls).toEqual([
      [DROP_CULTURAL_TASK_ASSIGNMENTS_SQL, [USER_ID]],
    ]);
    expect(DROP_CULTURAL_TASK_ASSIGNMENTS_SQL).toMatch(/^DELETE /);
    expect(DROP_CULTURAL_TASK_ASSIGNMENTS_SQL).not.toMatch(
      /INSERT|UPDATE|updated_at|notifications|mod_audit|FOR KEY SHARE/,
    );
  });
});
