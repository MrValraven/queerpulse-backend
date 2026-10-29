import { EntityManager } from 'typeorm';
import { PAYMENT_METHODS_LOCK_SQL } from './studio-payment-method-lock';
import {
  forgetSalesOfPersona,
  UNLINK_KEEP_TRACKS_SQL,
  UNLINK_PAYMENT_METHODS_DELETE_SQL,
  UNLINK_PENDING_EXPIRE_SQL,
  UNLINK_PRICES_CLEAR_SQL,
  UNLINK_SALES_DETACH_SQL,
  UNLINK_WALL_PERSONA_CLEAR_SQL,
} from './studio-purchases-unlink';

/**
 * Contract 4.7: the sales of a persona on unlink. The statements themselves
 * run on real Postgres in `studio-purchases-unlink.postgres.spec.ts`.
 */
describe('forgetSalesOfPersona', () => {
  const PERSONA_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);
    manager = { query } as unknown as EntityManager;
  });

  it('runs the six steps in contract order and answers the expired ids and the kept count', async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === UNLINK_PENDING_EXPIRE_SQL
          ? [{ id: 'p-1' }, { id: 'p-2' }]
          : sql === UNLINK_KEEP_TRACKS_SQL
            ? [{ kept_count: 3 }]
            : undefined,
      ),
    );

    await expect(forgetSalesOfPersona(manager, PERSONA_ID)).resolves.toEqual({
      expiredPurchaseIds: ['p-1', 'p-2'],
      keptTrackCount: 3,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      PAYMENT_METHODS_LOCK_SQL,
      UNLINK_PAYMENT_METHODS_DELETE_SQL,
      ...UNLINK_PRICES_CLEAR_SQL,
      UNLINK_PENDING_EXPIRE_SQL,
      UNLINK_KEEP_TRACKS_SQL,
      UNLINK_SALES_DETACH_SQL,
      UNLINK_WALL_PERSONA_CLEAR_SQL,
    ]);
  });

  it('passes the persona id as the one parameter of every statement', async () => {
    await forgetSalesOfPersona(manager, PERSONA_ID);

    expect(query.mock.calls.map(([, parameters]) => parameters)).toEqual(
      Array.from({ length: 8 }, () => [PERSONA_ID]),
    );
  });

  it('reads returned rows through WITH so the driver hands back rows', () => {
    expect(UNLINK_PENDING_EXPIRE_SQL).toMatch(/^WITH /);
    expect(UNLINK_KEEP_TRACKS_SQL).toMatch(/^WITH /);
  });

  it('answers an empty outcome when the mock returns nothing', async () => {
    await expect(forgetSalesOfPersona(manager, PERSONA_ID)).resolves.toEqual({
      expiredPurchaseIds: [],
      keptTrackCount: 0,
    });
  });

  it('keeps the wall flag when it clears the chosen persona', () => {
    expect(UNLINK_WALL_PERSONA_CLEAR_SQL).not.toContain('is_shown_as_persona');
    expect(UNLINK_WALL_PERSONA_CLEAR_SQL).toContain(
      'SET "shown_as_subprofile_id" = NULL',
    );
  });

  it('keeps tracks only for confirmed purchases, from the live download rules', () => {
    expect(UNLINK_KEEP_TRACKS_SQL).toContain(
      `"purchase"."status" = 'confirmed'`,
    );
    expect(UNLINK_KEEP_TRACKS_SQL).toContain(
      `"release"."status" <> 'taken_down'`,
    );
    expect(UNLINK_KEEP_TRACKS_SQL).toContain('"chosen_persona_moderation"');
    expect(UNLINK_KEEP_TRACKS_SQL).toContain('"track"."withheld_at" IS NULL');
    expect(UNLINK_KEEP_TRACKS_SQL).toContain('"track"."audio_key" IS NOT NULL');
  });

  it('takes the releases and their tracks off sale', () => {
    expect(UNLINK_PRICES_CLEAR_SQL.map((sql) => sql.split('\n')[0])).toEqual([
      'UPDATE "studio_releases"',
      'UPDATE "studio_tracks"',
    ]);
    for (const statement of UNLINK_PRICES_CLEAR_SQL) {
      expect(statement).toContain(
        `SET "price_mode" = 'not_for_sale', "price_cents" = NULL`,
      );
    }
  });

  it('stops at the first failing statement', async () => {
    query.mockRejectedValueOnce(new Error('lock timeout'));

    await expect(forgetSalesOfPersona(manager, PERSONA_ID)).rejects.toThrow(
      'lock timeout',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
