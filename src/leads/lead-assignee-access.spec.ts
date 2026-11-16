import type { EntityManager } from 'typeorm';
import {
  DROP_LEAD_ASSIGNMENTS_SQL,
  dropLeadAssignmentsOfUser,
  LOCK_LEADS_OF_ASSIGNEE_SQL,
  RECORD_LEAD_ACCESS_ENDED_SQL,
} from './lead-assignee-access';
import { LEAD_STAFF_HAS_ACCESS_SQL } from './lead-staff-eligibility';

const USER_ID = 'd5000000-0000-4000-8000-000000000001';
const LEAD_ID = 'd5000000-0000-4000-8000-000000000002';
const OTHER_LEAD_ID = 'd5000000-0000-4000-8000-000000000003';

describe('dropLeadAssignmentsOfUser', () => {
  let manager: EntityManager & { query: jest.Mock };

  beforeEach(() => {
    manager = { query: jest.fn() } as unknown as EntityManager & {
      query: jest.Mock;
    };
  });

  it('holds the contract SQL', () => {
    expect(DROP_LEAD_ASSIGNMENTS_SQL).toBe(
      `DELETE FROM "lead_assignees" AS "la" WHERE "la"."user_id" = $1 AND NOT EXISTS (SELECT 1 FROM "users" "staff" WHERE "staff"."id" = $1 AND ${LEAD_STAFF_HAS_ACCESS_SQL}) RETURNING "la"."lead_id"`,
    );
    expect(RECORD_LEAD_ACCESS_ENDED_SQL).toBe(
      `INSERT INTO "lead_entries" ("lead_id", "kind", "subject_user_id", "author_id") SELECT "ended"."lead_id", 'assignee_access_ended', $2::uuid, NULL FROM unnest($1::uuid[]) AS "ended"("lead_id")`,
    );
    expect(LOCK_LEADS_OF_ASSIGNEE_SQL).toBe(
      `SELECT 1 FROM "leads" WHERE "id" IN (SELECT "lead_id" FROM "lead_assignees" WHERE "user_id" = $1) ORDER BY "id" FOR KEY SHARE`,
    );
  });

  it('locks the leads of the user before the delete so a concurrent unassign commits first', async () => {
    manager.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[], 0]);
    await dropLeadAssignmentsOfUser(manager, USER_ID);
    expect(manager.query.mock.calls).toEqual([
      [LOCK_LEADS_OF_ASSIGNEE_SQL, [USER_ID]],
      [DROP_LEAD_ASSIGNMENTS_SQL, [USER_ID]],
    ]);
  });

  it('re-checks access inside the delete and records one entry per lead left', async () => {
    manager.query
      .mockResolvedValueOnce([{}, {}])
      .mockResolvedValueOnce([
        [{ lead_id: LEAD_ID }, { lead_id: OTHER_LEAD_ID }],
        2,
      ])
      .mockResolvedValueOnce([]);
    expect(await dropLeadAssignmentsOfUser(manager, USER_ID)).toEqual([
      LEAD_ID,
      OTHER_LEAD_ID,
    ]);
    expect(manager.query.mock.calls).toEqual([
      [LOCK_LEADS_OF_ASSIGNEE_SQL, [USER_ID]],
      [DROP_LEAD_ASSIGNMENTS_SQL, [USER_ID]],
      [RECORD_LEAD_ACCESS_ENDED_SQL, [[LEAD_ID, OTHER_LEAD_ID], USER_ID]],
    ]);
  });

  it('writes nothing more when the user held no assignment or still has access', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([[], 0]);
    expect(await dropLeadAssignmentsOfUser(manager, USER_ID)).toEqual([]);
    expect(manager.query).toHaveBeenCalledTimes(2);
  });

  it('reads no lead ids from a result of another shape', async () => {
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await dropLeadAssignmentsOfUser(manager, USER_ID)).toEqual([]);
    expect(manager.query).toHaveBeenCalledTimes(2);
  });

  it('leaves the lead timeline and every other table alone', () => {
    expect(
      `${DROP_LEAD_ASSIGNMENTS_SQL} ${RECORD_LEAD_ACCESS_ENDED_SQL}`,
    ).not.toMatch(/updated_at|"leads"|notifications|mod_audit/);
    expect(LOCK_LEADS_OF_ASSIGNEE_SQL).toMatch(/^SELECT /);
    expect(LOCK_LEADS_OF_ASSIGNEE_SQL).not.toMatch(/UPDATE|DELETE|INSERT/);
  });
});
