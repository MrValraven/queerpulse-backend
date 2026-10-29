import type { EntityManager } from 'typeorm';
import {
  HOUSE_ACCOUNT_ID_SQL,
  MUSIC_MANAGER_PRODUCER_ROLE,
  REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL,
  cohostSeatRefusalFor,
  isHouseAccountId,
  lockCohostSeatsForMember,
  removeHouseMusicCohostSeats,
} from './house-music-events';

const MEMBER_ID = 'e4000000-0000-4000-8000-000000000001';

function buildManager(rows: unknown[] = []): {
  manager: EntityManager;
  query: jest.Mock;
} {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
}

describe('house music events', () => {
  it('wraps the seat removal in WITH so the rows come back as rows', async () => {
    expect(REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL).toMatch(/^WITH /);
    const { manager, query } = buildManager([
      { event_id: 'event-1', event_slug: 'slug-one', event_title: 'Title one' },
    ]);
    await expect(
      removeHouseMusicCohostSeats(manager, MEMBER_ID),
    ).resolves.toEqual([
      { eventId: 'event-1', eventSlug: 'slug-one', eventTitle: 'Title one' },
    ]);
    expect(query).toHaveBeenCalledWith(REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL, [
      MEMBER_ID,
    ]);
  });

  it('keys the house on the official google id', () => {
    expect(HOUSE_ACCOUNT_ID_SQL).toContain(`'system:queerpulse'`);
    expect(REMOVE_HOUSE_MUSIC_COHOST_SEATS_SQL).toContain(HOUSE_ACCOUNT_ID_SQL);
  });

  it('answers false for a null user id without a query', async () => {
    const { manager, query } = buildManager();
    await expect(isHouseAccountId(manager, null)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers true when the query says the id is the house', async () => {
    const { manager, query } = buildManager([{ is_house: true }]);
    await expect(isHouseAccountId(manager, MEMBER_ID)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(HOUSE_ACCOUNT_ID_SQL),
      [MEMBER_ID],
    );
  });

  it('locks on the music_event_cohost prefix and the member id', async () => {
    const { manager, query } = buildManager();
    await lockCohostSeatsForMember(manager, MEMBER_ID);
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1::text))',
      [`music_event_cohost:${MEMBER_ID}`],
    );
  });

  it('names holds_grant before is_staff_tier when a moderator also holds the grant', async () => {
    const { manager, query } = buildManager([
      { refusal: 'music_event_cohost_holds_grant' },
    ]);
    await expect(cohostSeatRefusalFor(manager, MEMBER_ID)).resolves.toBe(
      'music_event_cohost_holds_grant',
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([MEMBER_ID, MUSIC_MANAGER_PRODUCER_ROLE]);
    expect(sql.indexOf('music_event_cohost_holds_grant')).toBeLessThan(
      sql.indexOf('music_event_cohost_is_staff_tier'),
    );
  });

  it('answers null when the member has no row or no refusal', async () => {
    await expect(
      cohostSeatRefusalFor(buildManager([]).manager, MEMBER_ID),
    ).resolves.toBeNull();
    await expect(
      cohostSeatRefusalFor(
        buildManager([{ refusal: null }]).manager,
        MEMBER_ID,
      ),
    ).resolves.toBeNull();
  });
});
