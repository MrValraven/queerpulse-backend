import type { EntityManager } from 'typeorm';
import {
  LEAD_STAFF_ELIGIBLE_SQL,
  LEAD_STAFF_GRANT_SQL,
  LEAD_STAFF_HAS_ACCESS_SQL,
  LEAD_STAFF_ROW_SQL,
  type LeadStaffEligibility,
  leadStaffEligibility,
} from './lead-staff-eligibility';

const USER_ID = 'd4000000-0000-4000-8000-000000000001';

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
    if (sql === LEAD_STAFF_ROW_SQL) return Promise.resolve(personRows);
    if (sql === LEAD_STAFF_GRANT_SQL) return Promise.resolve(grantRows);
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  return { query } as unknown as AnsweringManager;
}

function row(status: string, role: string, isSystem = false): PersonRow {
  return { status, role, is_system: isSystem };
}

describe('lead staff eligibility', () => {
  it('holds the contract SQL', () => {
    expect(LEAD_STAFF_HAS_ACCESS_SQL).toBe(
      `("staff"."role" = 'admin' OR EXISTS (SELECT 1 FROM "user_staff_roles" "staff_grant" WHERE "staff_grant"."user_id" = "staff"."id" AND "staff_grant"."role" = 'music_manager_producer'))`,
    );
    expect(LEAD_STAFF_ELIGIBLE_SQL).toBe(
      `("staff"."status" = 'active' AND "staff"."is_system" = false AND ${LEAD_STAFF_HAS_ACCESS_SQL})`,
    );
    expect(LEAD_STAFF_ROW_SQL).toContain('INNER JOIN "profiles" "profile"');
    expect(LEAD_STAFF_ROW_SQL).toMatch(/FOR SHARE OF "staff"$/);
    expect(LEAD_STAFF_GRANT_SQL).toMatch(
      /AND "role" = 'music_manager_producer' FOR SHARE$/,
    );
  });

  it('reads the person and the grant under share locks in the caller transaction', async () => {
    const manager = managerAnswering(
      [{ status: 'active', role: 'admin', is_system: false }],
      [],
    );
    await leadStaffEligibility(manager, USER_ID);
    expect(manager.query.mock.calls).toEqual([
      [LEAD_STAFF_ROW_SQL, [USER_ID]],
      [LEAD_STAFF_GRANT_SQL, [USER_ID]],
    ]);
  });

  it('runs both reads for a person with no profile', async () => {
    const manager = managerAnswering([], []);
    await leadStaffEligibility(manager, USER_ID);
    expect(manager.query).toHaveBeenCalledTimes(2);
  });

  it.each<[string, PersonRow[], object[], LeadStaffEligibility]>([
    ['no person with a profile', [], [], { kind: 'not_found' }],
    [
      'the house account, even holding the grant',
      [row('active', 'admin', true)],
      [{}],
      { kind: 'ineligible', reason: 'no_access' },
    ],
    [
      'a member with no grant',
      [row('active', 'member')],
      [],
      { kind: 'ineligible', reason: 'no_access' },
    ],
    [
      'a moderator with no grant',
      [row('active', 'moderator')],
      [],
      { kind: 'ineligible', reason: 'no_access' },
    ],
    [
      'a suspended grant holder',
      [row('suspended', 'member')],
      [{}],
      { kind: 'ineligible', reason: 'suspended' },
    ],
    [
      'a suspended member with no grant',
      [row('suspended', 'member')],
      [],
      { kind: 'ineligible', reason: 'no_access' },
    ],
    [
      'a deactivated admin',
      [row('deactivated', 'admin')],
      [],
      { kind: 'ineligible', reason: 'deactivated' },
    ],
    ['an active admin', [row('active', 'admin')], [], { kind: 'eligible' }],
    [
      'an active grant holder',
      [row('active', 'member')],
      [{}],
      { kind: 'eligible' },
    ],
  ])('answers %s', async (_label, personRows, grantRows, expected) => {
    expect(
      await leadStaffEligibility(
        managerAnswering(personRows, grantRows),
        USER_ID,
      ),
    ).toEqual(expected);
  });
});
