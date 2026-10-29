import type { EntityManager } from 'typeorm';
import {
  PAYMENT_METHODS_LOCK_SQL,
  PAYMENT_METHOD_COUNT_SQL,
  PERSONA_HAS_ITEMS_FOR_SALE_SQL,
  RELEASE_TRACKS_PRICED_SQL,
  countPaymentMethods,
  lockPaymentMethodsOf,
  personaHasItemsForSale,
  releaseHasPricedTracks,
} from './studio-payment-method-lock';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const TRACK_ID = '33333333-3333-4333-8333-333333333333';

describe('studio payment-method lock', () => {
  const query = jest.fn();
  const manager = { query } as unknown as EntityManager;

  beforeEach(() => {
    query.mockReset();
  });

  it('takes a transaction-scoped lock keyed on the persona id', async () => {
    query.mockResolvedValue([]);
    await lockPaymentMethodsOf(manager, PERSONA_ID);
    expect(query.mock.calls).toEqual([
      [PAYMENT_METHODS_LOCK_SQL, [PERSONA_ID]],
    ]);
    expect(PAYMENT_METHODS_LOCK_SQL).toContain(
      `pg_advisory_xact_lock(hashtext('studio_payment_methods:' || $1::text))`,
    );
  });

  it('counts the methods of one persona', async () => {
    query.mockResolvedValueOnce([{ count: 2 }]);
    await expect(countPaymentMethods(manager, PERSONA_ID)).resolves.toBe(2);
    query.mockResolvedValueOnce([]);
    await expect(countPaymentMethods(manager, PERSONA_ID)).resolves.toBe(0);
    expect(query.mock.calls).toEqual([
      [PAYMENT_METHOD_COUNT_SQL, [PERSONA_ID]],
      [PAYMENT_METHOD_COUNT_SQL, [PERSONA_ID]],
    ]);
    expect(PAYMENT_METHOD_COUNT_SQL).toContain('COUNT(*)::int');
    expect(PAYMENT_METHOD_COUNT_SQL).toContain('"subprofile_id" = $1');
  });

  it('reads anything for sale across the releases and their tracks', async () => {
    expect(PERSONA_HAS_ITEMS_FOR_SALE_SQL).toMatch(
      /"release"\."price_mode" <> 'not_for_sale'/,
    );
    expect(PERSONA_HAS_ITEMS_FOR_SALE_SQL).toMatch(
      /"track"\."price_mode" <> 'not_for_sale'/,
    );
    query.mockResolvedValueOnce([{ has_items_for_sale: true }]);
    await expect(personaHasItemsForSale(manager, PERSONA_ID)).resolves.toBe(
      true,
    );
    query.mockResolvedValueOnce([{ has_items_for_sale: false }]);
    await expect(personaHasItemsForSale(manager, PERSONA_ID)).resolves.toBe(
      false,
    );
    query.mockResolvedValueOnce([]);
    await expect(personaHasItemsForSale(manager, PERSONA_ID)).resolves.toBe(
      false,
    );
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      [PERSONA_ID],
      [PERSONA_ID],
      [PERSONA_ID],
    ]);
  });

  it('leaves the track being written out of the release check', async () => {
    expect(RELEASE_TRACKS_PRICED_SQL).toContain(
      '$2::uuid IS NULL OR "track"."id" <> $2::uuid',
    );
    query.mockResolvedValueOnce([{ has_priced_tracks: true }]);
    await expect(
      releaseHasPricedTracks(manager, RELEASE_ID, TRACK_ID),
    ).resolves.toBe(true);
    query.mockResolvedValueOnce([{ has_priced_tracks: false }]);
    await expect(
      releaseHasPricedTracks(manager, RELEASE_ID, null),
    ).resolves.toBe(false);
    expect(query.mock.calls).toEqual([
      [RELEASE_TRACKS_PRICED_SQL, [RELEASE_ID, TRACK_ID]],
      [RELEASE_TRACKS_PRICED_SQL, [RELEASE_ID, null]],
    ]);
  });
});
