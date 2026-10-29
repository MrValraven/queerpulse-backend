import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AdminSpotlightArtistRow } from './admin-studio-spotlight-response';
import {
  ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL,
  ADMIN_SPOTLIGHT_SQL,
  CLOSE_SPOTLIGHT_GAP_SQL,
  DEFER_SPOTLIGHT_POSITIONS_SQL,
  DELETE_ARTIST_OF_THE_MONTH_SQL,
  DELETE_SPOTLIGHT_SQL,
  INSERT_SPOTLIGHT_SQL,
  LOCK_SPOTLIGHT_PERSONA_SQL,
  LOCK_SPOTLIGHT_SQL,
  NEW_STAR_IDS_SQL,
  REORDER_NEW_STARS_SQL,
  SPOTLIGHT_PLACEMENT_STATE_SQL,
  SPOTLIGHT_SLOT_SUBPROFILE_CONSTRAINT,
  UPDATE_SPOTLIGHT_NOTE_SQL,
} from './admin-studio-spotlight-sql';
import { AdminStudioSpotlightService } from './admin-studio-spotlight.service';
import { StudioSpotlightSlot } from './studio.constants';

const STAFF_ID = 'd7200000-0000-4000-8000-000000000001';
const PERSONA = 'd7200000-0000-4000-8000-000000000011';
const OTHER_PERSONA = 'd7200000-0000-4000-8000-000000000012';
const MONTH_SPOTLIGHT = 'd7200000-0000-4000-8000-000000000021';
const FIRST_STAR = 'd7200000-0000-4000-8000-000000000031';
const SECOND_STAR = 'd7200000-0000-4000-8000-000000000032';
const NEW_SPOTLIGHT = 'd7200000-0000-4000-8000-000000000041';
const PICKED_AT = new Date('2026-10-01T09:00:00.000Z');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const spotlightRow = (
  id: string,
  slot: StudioSpotlightSlot,
  position: number,
  personaId: string,
  overrides: Partial<AdminSpotlightArtistRow> = {},
): AdminSpotlightArtistRow => ({
  id,
  slot,
  position,
  note: null,
  created_at: PICKED_AT,
  is_listenable: true,
  artist_id: personaId,
  artist_handle: `handle-${position}`,
  artist_display_name: `Artist ${position}`,
  artist_kind: 'musician',
  artist_avatar_url: null,
  ...overrides,
});

const placeableState = (overrides: Record<string, unknown> = {}) => ({
  is_artist: true,
  has_release: true,
  is_in_new_stars: false,
  new_stars_count: 0,
  ...overrides,
});

describe('AdminStudioSpotlightService', () => {
  let query: jest.Mock;
  let managerResults: Map<string, unknown>;
  let manager: { query: jest.Mock };
  let service: AdminStudioSpotlightService;

  const managerSqlOrder = (): unknown[] =>
    manager.query.mock.calls.map((call: unknown[]) => call[0]);
  const managerArgsOf = (sql: string): unknown[] | undefined =>
    (manager.query.mock.calls as unknown[][]).find(
      (call) => call[0] === sql,
    )?.[1] as unknown[] | undefined;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    managerResults = new Map<string, unknown>([
      [SPOTLIGHT_PLACEMENT_STATE_SQL, [placeableState()]],
      [INSERT_SPOTLIGHT_SQL, [{ id: NEW_SPOTLIGHT }]],
      [DELETE_SPOTLIGHT_SQL, [{ slot: 'new_stars', position: 3 }]],
      [NEW_STAR_IDS_SQL, [{ id: FIRST_STAR }, { id: SECOND_STAR }]],
    ]);
    manager = {
      query: jest.fn((sql: string) => {
        const result = managerResults.get(sql);
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result ?? []);
      }),
    };
    const dataSource = {
      query,
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new AdminStudioSpotlightService(
      dataSource as unknown as DataSource,
    );
  });

  describe('getSpotlight', () => {
    it('groups both slots in position order with listenability and the pick date', async () => {
      query.mockResolvedValueOnce([
        spotlightRow(MONTH_SPOTLIGHT, 'artist_of_the_month', 1, PERSONA, {
          note: 'Out now',
        }),
        spotlightRow(FIRST_STAR, 'new_stars', 1, OTHER_PERSONA),
        spotlightRow(SECOND_STAR, 'new_stars', 2, PERSONA, {
          is_listenable: false,
        }),
      ]);

      const spotlight = await service.getSpotlight();

      expect(query).toHaveBeenCalledWith(ADMIN_SPOTLIGHT_SQL, [null, null]);
      expect(spotlight).toEqual({
        artistOfTheMonth: {
          id: MONTH_SPOTLIGHT,
          slot: 'artist_of_the_month',
          position: 1,
          note: 'Out now',
          createdAt: '2026-10-01T09:00:00.000Z',
          isListenable: true,
          artist: {
            id: PERSONA,
            handle: 'handle-1',
            name: 'Artist 1',
            kind: 'musician',
            avatarUrl: null,
          },
        },
        newStars: [
          expect.objectContaining({
            id: FIRST_STAR,
            position: 1,
            isListenable: true,
          }),
          expect.objectContaining({
            id: SECOND_STAR,
            position: 2,
            isListenable: false,
          }),
        ],
      });
    });

    it('answers an empty spotlight when no row exists', async () => {
      expect(await service.getSpotlight()).toEqual({
        artistOfTheMonth: null,
        newStars: [],
      });
    });
  });

  describe('searchArtists', () => {
    it('matches folded names and handles with an escaped like term, 20 at most', async () => {
      await service.searchArtists('  50% ');

      expect(query).toHaveBeenCalledWith(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL, [
        `%50\\%%`,
        20,
      ]);
    });

    it('flags artists already in either slot', async () => {
      query.mockResolvedValueOnce([
        {
          artist_id: PERSONA,
          artist_handle: 'ana',
          artist_display_name: 'Ana',
          artist_kind: 'dj',
          artist_avatar_url: null,
          latest_release_title: 'Night bus',
          is_in_artist_of_the_month: true,
          is_in_new_stars: false,
        },
        {
          artist_id: OTHER_PERSONA,
          artist_handle: 'bea',
          artist_display_name: 'Bea',
          artist_kind: 'poet',
          artist_avatar_url: null,
          latest_release_title: null,
          is_in_artist_of_the_month: false,
          is_in_new_stars: true,
        },
      ]);

      expect(await service.searchArtists('a')).toEqual({
        items: [
          {
            artist: {
              id: PERSONA,
              handle: 'ana',
              name: 'Ana',
              kind: 'dj',
              avatarUrl: null,
            },
            latestReleaseTitle: 'Night bus',
            isInArtistOfTheMonth: true,
            isInNewStars: false,
          },
          {
            artist: {
              id: OTHER_PERSONA,
              handle: 'bea',
              name: 'Bea',
              kind: 'poet',
              avatarUrl: null,
            },
            latestReleaseTitle: null,
            isInArtistOfTheMonth: false,
            isInNewStars: true,
          },
        ],
      });
    });
  });

  describe('setArtistOfTheMonth', () => {
    beforeEach(() => {
      query.mockResolvedValue([
        spotlightRow(NEW_SPOTLIGHT, 'artist_of_the_month', 1, PERSONA),
      ]);
    });

    it('replaces the current artist in one locked transaction with a fresh row', async () => {
      const placed = await service.setArtistOfTheMonth(STAFF_ID, {
        subprofileId: PERSONA,
        note: 'Out now',
      });

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_PERSONA_SQL,
        LOCK_SPOTLIGHT_SQL,
        SPOTLIGHT_PLACEMENT_STATE_SQL,
        DELETE_ARTIST_OF_THE_MONTH_SQL,
        INSERT_SPOTLIGHT_SQL,
      ]);
      expect(managerArgsOf(LOCK_SPOTLIGHT_PERSONA_SQL)).toEqual([PERSONA]);
      expect(managerArgsOf(SPOTLIGHT_PLACEMENT_STATE_SQL)).toEqual([PERSONA]);
      expect(managerArgsOf(INSERT_SPOTLIGHT_SQL)).toEqual([
        'artist_of_the_month',
        PERSONA,
        'Out now',
        STAFF_ID,
      ]);
      expect(query).toHaveBeenCalledWith(ADMIN_SPOTLIGHT_SQL, [
        null,
        NEW_SPOTLIGHT,
      ]);
      expect(placed.id).toBe(NEW_SPOTLIGHT);
    });

    it('starts a fresh row when the same artist is set again', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ is_in_new_stars: true, new_stars_count: 12 }),
      ]);

      await service.setArtistOfTheMonth(STAFF_ID, { subprofileId: PERSONA });

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_PERSONA_SQL,
        LOCK_SPOTLIGHT_SQL,
        SPOTLIGHT_PLACEMENT_STATE_SQL,
        DELETE_ARTIST_OF_THE_MONTH_SQL,
        INSERT_SPOTLIGHT_SQL,
      ]);
    });

    it('stores a trimmed note and an empty one as null', async () => {
      await service.setArtistOfTheMonth(STAFF_ID, {
        subprofileId: PERSONA,
        note: '  Out now ',
      });
      await service.setArtistOfTheMonth(STAFF_ID, {
        subprofileId: PERSONA,
        note: '   ',
      });
      await service.setArtistOfTheMonth(STAFF_ID, { subprofileId: PERSONA });

      const insertedNotes = (manager.query.mock.calls as unknown[][])
        .filter((call) => call[0] === INSERT_SPOTLIGHT_SQL)
        .map((call) => (call[1] as unknown[])[2]);
      expect(insertedNotes).toEqual(['Out now', null, null]);
    });

    it('refuses a persona that is not a public Studio artist with studio_spotlight_not_an_artist', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ is_artist: false }),
      ]);
      expect(
        await codeOf(
          service.setArtistOfTheMonth(STAFF_ID, { subprofileId: PERSONA }),
        ),
      ).toBe('studio_spotlight_not_an_artist');

      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, []);
      expect(
        await codeOf(
          service.setArtistOfTheMonth(STAFF_ID, { subprofileId: PERSONA }),
        ),
      ).toBe('studio_spotlight_not_an_artist');
      expect(managerSqlOrder()).not.toContain(DELETE_ARTIST_OF_THE_MONTH_SQL);
    });

    it('refuses an artist with no published release with studio_spotlight_no_release before deleting anything', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ has_release: false }),
      ]);

      expect(
        await codeOf(
          service.setArtistOfTheMonth(STAFF_ID, { subprofileId: PERSONA }),
        ),
      ).toBe('studio_spotlight_no_release');
      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_PERSONA_SQL,
        LOCK_SPOTLIGHT_SQL,
        SPOTLIGHT_PLACEMENT_STATE_SQL,
      ]);
    });
  });

  describe('clearArtistOfTheMonth', () => {
    it('deletes the artist of the month under the lock and resolves when the slot is empty', async () => {
      await expect(service.clearArtistOfTheMonth()).resolves.toBeUndefined();

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_SQL,
        DELETE_ARTIST_OF_THE_MONTH_SQL,
      ]);
    });
  });

  describe('addNewStar', () => {
    beforeEach(() => {
      query.mockResolvedValue([
        spotlightRow(NEW_SPOTLIGHT, 'new_stars', 3, PERSONA),
      ]);
    });

    it('appends after the last position under the table lock', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ new_stars_count: 2 }),
      ]);

      const added = await service.addNewStar(STAFF_ID, {
        subprofileId: PERSONA,
        note: ' First EP ',
      });

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_PERSONA_SQL,
        LOCK_SPOTLIGHT_SQL,
        SPOTLIGHT_PLACEMENT_STATE_SQL,
        INSERT_SPOTLIGHT_SQL,
      ]);
      expect(managerArgsOf(INSERT_SPOTLIGHT_SQL)).toEqual([
        'new_stars',
        PERSONA,
        'First EP',
        STAFF_ID,
      ]);
      expect(added).toEqual(
        expect.objectContaining({ id: NEW_SPOTLIGHT, position: 3 }),
      );
    });

    it('refuses a thirteenth artist with studio_spotlight_slot_full', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ new_stars_count: 12 }),
      ]);

      expect(
        await codeOf(service.addNewStar(STAFF_ID, { subprofileId: PERSONA })),
      ).toBe('studio_spotlight_slot_full');
      expect(managerSqlOrder()).not.toContain(INSERT_SPOTLIGHT_SQL);
    });

    it('refuses an artist already in New stars with studio_spotlight_already_in_slot', async () => {
      managerResults.set(SPOTLIGHT_PLACEMENT_STATE_SQL, [
        placeableState({ is_in_new_stars: true, new_stars_count: 12 }),
      ]);

      expect(
        await codeOf(service.addNewStar(STAFF_ID, { subprofileId: PERSONA })),
      ).toBe('studio_spotlight_already_in_slot');
      expect(managerSqlOrder()).not.toContain(INSERT_SPOTLIGHT_SQL);
    });

    it('answers studio_spotlight_already_in_slot when the unique key catches a race', async () => {
      managerResults.set(
        INSERT_SPOTLIGHT_SQL,
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: SPOTLIGHT_SLOT_SUBPROFILE_CONSTRAINT,
        }),
      );

      expect(
        await codeOf(service.addNewStar(STAFF_ID, { subprofileId: PERSONA })),
      ).toBe('studio_spotlight_already_in_slot');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('updateNote', () => {
    it('stores the trimmed note and keeps the pick date', async () => {
      query.mockResolvedValueOnce([{ id: FIRST_STAR }]).mockResolvedValueOnce([
        spotlightRow(FIRST_STAR, 'new_stars', 1, PERSONA, {
          note: 'Live at the pier',
        }),
      ]);

      const updated = await service.updateNote(FIRST_STAR, {
        note: '  Live at the pier ',
      });

      expect(query).toHaveBeenNthCalledWith(1, UPDATE_SPOTLIGHT_NOTE_SQL, [
        FIRST_STAR,
        'Live at the pier',
      ]);
      expect(query).toHaveBeenNthCalledWith(2, ADMIN_SPOTLIGHT_SQL, [
        null,
        FIRST_STAR,
      ]);
      expect(updated).toEqual(
        expect.objectContaining({
          note: 'Live at the pier',
          createdAt: '2026-10-01T09:00:00.000Z',
        }),
      );
    });

    it('answers studio_spotlight_not_found for an unknown id', async () => {
      expect(await codeOf(service.updateNote(FIRST_STAR, { note: null }))).toBe(
        'studio_spotlight_not_found',
      );
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeSpotlightArtist', () => {
    it('deletes the row and closes the gap in its slot', async () => {
      await service.removeSpotlightArtist(SECOND_STAR);

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_SQL,
        DELETE_SPOTLIGHT_SQL,
        CLOSE_SPOTLIGHT_GAP_SQL,
      ]);
      expect(managerArgsOf(DELETE_SPOTLIGHT_SQL)).toEqual([SECOND_STAR]);
      expect(managerArgsOf(CLOSE_SPOTLIGHT_GAP_SQL)).toEqual(['new_stars', 3]);
    });

    it('answers studio_spotlight_not_found for an unknown id', async () => {
      managerResults.set(DELETE_SPOTLIGHT_SQL, []);

      expect(await codeOf(service.removeSpotlightArtist(SECOND_STAR))).toBe(
        'studio_spotlight_not_found',
      );
      expect(managerSqlOrder()).not.toContain(CLOSE_SPOTLIGHT_GAP_SQL);
    });
  });

  describe('reorderNewStars', () => {
    it('locks, defers the position constraint and writes 1..n in one statement', async () => {
      query.mockResolvedValueOnce([
        spotlightRow(SECOND_STAR, 'new_stars', 1, OTHER_PERSONA),
        spotlightRow(FIRST_STAR, 'new_stars', 2, PERSONA),
      ]);

      const reordered = await service.reorderNewStars([
        SECOND_STAR.toUpperCase(),
        FIRST_STAR,
      ]);

      expect(managerSqlOrder()).toEqual([
        LOCK_SPOTLIGHT_SQL,
        DEFER_SPOTLIGHT_POSITIONS_SQL,
        NEW_STAR_IDS_SQL,
        REORDER_NEW_STARS_SQL,
      ]);
      expect(managerArgsOf(REORDER_NEW_STARS_SQL)).toEqual([
        [SECOND_STAR, FIRST_STAR],
        [1, 2],
      ]);
      expect(query).toHaveBeenCalledWith(ADMIN_SPOTLIGHT_SQL, [
        'new_stars',
        null,
      ]);
      expect(reordered.map((spotlightArtist) => spotlightArtist.id)).toEqual([
        SECOND_STAR,
        FIRST_STAR,
      ]);
    });

    it('answers studio_spotlight_order_mismatch for a repeated, missing or foreign id', async () => {
      expect(
        await codeOf(service.reorderNewStars([FIRST_STAR, FIRST_STAR])),
      ).toBe('studio_spotlight_order_mismatch');
      expect(await codeOf(service.reorderNewStars([FIRST_STAR]))).toBe(
        'studio_spotlight_order_mismatch',
      );
      expect(
        await codeOf(service.reorderNewStars([FIRST_STAR, MONTH_SPOTLIGHT])),
      ).toBe('studio_spotlight_order_mismatch');
      expect(managerSqlOrder()).not.toContain(REORDER_NEW_STARS_SQL);
    });
  });
});
