import { clearUnmanagedFutureRunByLinks } from './run-by-listing-links';

const NOW = new Date('2026-10-08T12:00:00.000Z');

/** The SQL the pass sent, with its whitespace collapsed for matching. */
function sentSql(query: jest.Mock): string {
  const [sql] = query.mock.calls[0] as [string, unknown[]];
  return sql.replace(/\s+/g, ' ');
}

function sentParameters(query: jest.Mock): unknown[] {
  return (query.mock.calls[0] as [string, unknown[]])[1];
}

describe('clearUnmanagedFutureRunByLinks', () => {
  it('clears the link in one UPDATE on the events table', async () => {
    const query = jest.fn().mockResolvedValue([[], 3]);

    const clearedCount = await clearUnmanagedFutureRunByLinks(
      { query },
      { listingId: 'listing-1' },
      NOW,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(sentSql(query)).toContain(
      'UPDATE "events" AS "event" SET "run_by_listing_id" = NULL',
    );
    expect(clearedCount).toBe(3);
  });

  it('touches only gatherings that start or end at or after now, so past ones keep the line', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);

    await clearUnmanagedFutureRunByLinks(
      { query },
      { listingId: 'listing-1' },
      NOW,
    );

    expect(sentSql(query)).toContain(
      '("event"."start_at" >= $1 OR "event"."end_at" >= $1)',
    );
    expect(sentParameters(query)[0]).toBe(NOW);
  });

  it('keeps the link of a host who still owns the listing or holds an active seat on it', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);

    await clearUnmanagedFutureRunByLinks(
      { query },
      { listingId: 'listing-1' },
      NOW,
    );

    const sql = sentSql(query);
    expect(sql).toContain(
      'NOT EXISTS ( SELECT 1 FROM "listings" "listing" WHERE "listing"."id" = "event"."run_by_listing_id" AND "listing"."owner_id" = "event"."host_id" )',
    );
    expect(sql).toContain(
      'NOT EXISTS ( SELECT 1 FROM "listing_co_managers" "seat" WHERE "seat"."listing_id" = "event"."run_by_listing_id" AND "seat"."user_id" = "event"."host_id" AND "seat"."status" = \'active\' )',
    );
  });

  it('scopes a listing pass to the gatherings that name that listing', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);

    await clearUnmanagedFutureRunByLinks(
      { query },
      { listingId: 'listing-1' },
      NOW,
    );

    expect(sentSql(query)).toContain('"event"."run_by_listing_id" = $2');
    expect(sentParameters(query)).toEqual([NOW, 'listing-1']);
  });

  it('scopes an event pass to the gatherings it names', async () => {
    const query = jest.fn().mockResolvedValue([[], 1]);

    await clearUnmanagedFutureRunByLinks(
      { query },
      { eventIds: ['event-1', 'event-2'] },
      NOW,
    );

    expect(sentSql(query)).toContain('"event"."id" = ANY($2::uuid[])');
    expect(sentParameters(query)).toEqual([NOW, ['event-1', 'event-2']]);
  });

  it('sends nothing for an empty event list', async () => {
    const query = jest.fn();

    await expect(
      clearUnmanagedFutureRunByLinks({ query }, { eventIds: [] }, NOW),
    ).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads a result with no affected count as nothing cleared', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await expect(
      clearUnmanagedFutureRunByLinks(
        { query },
        { listingId: 'listing-1' },
        NOW,
      ),
    ).resolves.toBe(0);
  });
});
