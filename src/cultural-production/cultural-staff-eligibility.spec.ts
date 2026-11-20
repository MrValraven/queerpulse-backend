import type { EntityManager } from 'typeorm';
import { CULTURAL_ACCESS_STAFF_ROLES } from './cultural-production.constants';
import {
  CULTURAL_STAFF_ELIGIBLE_SQL,
  CULTURAL_STAFF_GRANT_SQL,
  CULTURAL_STAFF_HAS_ACCESS_SQL,
  CULTURAL_STAFF_ROW_SQL,
  culturalStaffEligibility,
} from './cultural-staff-eligibility';

const USER_ID = 'e2000000-0000-4000-8000-000000000001';

interface PersonRow {
  status: string;
  role: string;
  is_system: boolean;
}

type AnsweringManager = EntityManager & { query: jest.Mock };

/** A manager whose `query` answers the person read and the grant read by SQL text. */
function managerAnswering(
  personRows: PersonRow[],
  grantRows: object[],
): AnsweringManager {
  const query = jest.fn((sql: string) => {
    if (sql === CULTURAL_STAFF_ROW_SQL) return Promise.resolve(personRows);
    if (sql === CULTURAL_STAFF_GRANT_SQL) return Promise.resolve(grantRows);
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  return { query } as unknown as AnsweringManager;
}

/** One person row with the given status and role. */
function personRow(status: string, role: string, isSystem = false): PersonRow {
  return { status, role, is_system: isSystem };
}

/**
 * An active member holding one grant: the grant read answers a row only when
 * its SQL or params name that role, so a role missing from the list reads as
 * no grant.
 */
function managerHoldingGrant(heldRole: string): AnsweringManager {
  const query = jest.fn((sql: string, parameters: unknown[] = []) => {
    if (sql === CULTURAL_STAFF_ROW_SQL) {
      return Promise.resolve([personRow('active', 'member')]);
    }
    if (sql === CULTURAL_STAFF_GRANT_SQL) {
      const isRoleRead =
        sql.includes(`'${heldRole}'`) || parameters.includes(heldRole);
      return Promise.resolve(isRoleRead ? [{ '?column?': 1 }] : []);
    }
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  return { query } as unknown as AnsweringManager;
}

describe('culturalStaffEligibility', () => {
  it('holds the contract SQL', () => {
    expect(CULTURAL_STAFF_HAS_ACCESS_SQL).toBe(
      `("staff"."role" IN ('moderator', 'admin') OR EXISTS (SELECT 1 FROM "user_staff_roles" "staff_grant" WHERE "staff_grant"."user_id" = "staff"."id" AND "staff_grant"."role" IN ('cultural_producer', 'music_manager_producer')))`,
    );
    expect(CULTURAL_STAFF_ELIGIBLE_SQL).toBe(
      `("staff"."status" = 'active' AND "staff"."is_system" = false AND ${CULTURAL_STAFF_HAS_ACCESS_SQL})`,
    );
    expect(CULTURAL_STAFF_ROW_SQL).toBe(
      `SELECT "staff"."status", "staff"."role", "staff"."is_system" FROM "users" "staff" INNER JOIN "profiles" "profile" ON "profile"."user_id" = "staff"."id" WHERE "staff"."id" = $1 FOR SHARE OF "staff"`,
    );
    expect(CULTURAL_STAFF_GRANT_SQL).toBe(
      `SELECT 1 FROM "user_staff_roles" WHERE "user_id" = $1 AND "role" IN ('cultural_producer', 'music_manager_producer') FOR SHARE`,
    );
  });

  it('builds the grant list from CULTURAL_ACCESS_STAFF_ROLES', () => {
    expect(CULTURAL_ACCESS_STAFF_ROLES).toEqual([
      'cultural_producer',
      'music_manager_producer',
    ]);
    for (const staffRole of CULTURAL_ACCESS_STAFF_ROLES) {
      expect(CULTURAL_STAFF_HAS_ACCESS_SQL).toContain(`'${staffRole}'`);
      expect(CULTURAL_STAFF_GRANT_SQL).toContain(`'${staffRole}'`);
    }
  });

  it('answers not_found with no profile row', async () => {
    expect(
      await culturalStaffEligibility(managerAnswering([], [{}]), USER_ID),
    ).toEqual({ kind: 'not_found' });
  });

  it('refuses the house account as no_access', async () => {
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('active', 'admin', true)], [{}]),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'no_access' });
  });

  it('admits a moderator with no grant', async () => {
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('active', 'moderator')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'eligible' });
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('active', 'admin')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'eligible' });
  });

  it('admits a member holding cultural_producer', async () => {
    const manager = managerHoldingGrant('cultural_producer');
    expect(await culturalStaffEligibility(manager, USER_ID)).toEqual({
      kind: 'eligible',
    });
  });

  it('admits a member holding music_manager_producer', async () => {
    const manager = managerHoldingGrant('music_manager_producer');
    expect(await culturalStaffEligibility(manager, USER_ID)).toEqual({
      kind: 'eligible',
    });
  });

  it('refuses a member with no grant as no_access', async () => {
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('active', 'member')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'no_access' });
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('suspended', 'member')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'no_access' });
  });

  it('names suspended before deactivated', async () => {
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('suspended', 'moderator')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'suspended' });
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('suspended', 'member')], [{}]),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'suspended' });
    expect(
      await culturalStaffEligibility(
        managerAnswering([personRow('deactivated', 'admin')], []),
        USER_ID,
      ),
    ).toEqual({ kind: 'ineligible', reason: 'deactivated' });
  });

  it('always runs both share-locked reads', async () => {
    const managers = [
      managerAnswering([], []),
      managerAnswering([personRow('active', 'admin', true)], []),
      managerAnswering([personRow('active', 'member')], []),
      managerAnswering([personRow('active', 'moderator')], []),
    ];
    for (const manager of managers) {
      await culturalStaffEligibility(manager, USER_ID);
      expect(manager.query.mock.calls).toEqual([
        [CULTURAL_STAFF_ROW_SQL, [USER_ID]],
        [CULTURAL_STAFF_GRANT_SQL, [USER_ID]],
      ]);
    }
    expect(CULTURAL_STAFF_ROW_SQL).toMatch(/FOR SHARE OF "staff"$/);
    expect(CULTURAL_STAFF_GRANT_SQL).toMatch(/FOR SHARE$/);
  });
});
