import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  APPEND_PLAYLIST_ENTRIES_SQL,
  LOCK_ADDED_TRACKS_SQL,
  LOCK_CREDIT_PERSONA_SQL,
  RENUMBER_PLAYLIST_ENTRIES_SQL,
  REORDER_PLAYLIST_ENTRIES_SQL,
  StudioPlaylistWritesService,
  TOUCH_PLAYLIST_SQL,
  isDeadlockError,
} from './studio-playlist-writes.service';

const OWNER_ID = 'f3000000-0000-4000-8000-000000000001';
const OTHER_MEMBER_ID = 'f3000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'f4000000-0000-4000-8000-000000000001';
const PLAYLIST_ID = 'f5000000-0000-4000-8000-000000000001';
const TRACK_A = 'f6000000-0000-4000-8000-00000000000a';
const TRACK_B = 'f6000000-0000-4000-8000-00000000000b';
const TRACK_C = 'f6000000-0000-4000-8000-00000000000c';
const ENTRY_ONE = 'f7000000-0000-4000-8000-000000000001';
const ENTRY_TWO = 'f7000000-0000-4000-8000-000000000002';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

const playlistRow = (overrides: Partial<StudioPlaylist> = {}): StudioPlaylist =>
  ({
    id: PLAYLIST_ID,
    userId: OWNER_ID,
    name: 'Night bus',
    description: null,
    visibility: StudioPlaylistVisibility.Public,
    creditSubprofileId: null,
    isCreditedToPersona: false,
    ...overrides,
  }) as StudioPlaylist;

describe('StudioPlaylistWritesService', () => {
  let playlist: StudioPlaylist;
  let entryRows: Partial<StudioPlaylistTrack>[];
  let isCreditStanding: boolean;
  let isPersonaRowPresent: boolean;
  let missingTrackIds: Set<string>;
  let manager: {
    query: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let ownership: { listUploadablePersonas: jest.Mock };
  let playlistReads: { getPlaylist: jest.Mock; playableTrackIds: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let service: StudioPlaylistWritesService;

  const statementsMatching = (sql: string): unknown[][] =>
    manager.query.mock.calls
      .filter(([statement]) => statement === sql)
      .map(([, parameters]) => parameters as unknown[]);

  const firstCallOrderOf = (sql: string): number => {
    const callIndex = manager.query.mock.calls.findIndex(
      ([statement]) => statement === sql,
    );
    return manager.query.mock.invocationCallOrder[callIndex] ?? 0;
  };

  const queryResult = (sql: string, parameters: unknown[] = []): unknown => {
    if (sql.includes('AS "is_standing"')) {
      return [{ is_standing: isCreditStanding }];
    }
    if (sql === LOCK_CREDIT_PERSONA_SQL) {
      return isPersonaRowPresent ? [{ id: parameters[0] }] : [];
    }
    if (sql === LOCK_ADDED_TRACKS_SQL) {
      return (parameters[0] as string[])
        .filter((trackId) => !missingTrackIds.has(trackId))
        .map((trackId) => ({ id: trackId }));
    }
    return undefined;
  };

  beforeEach(() => {
    playlist = playlistRow();
    entryRows = [];
    isCreditStanding = true;
    isPersonaRowPresent = true;
    missingTrackIds = new Set();
    manager = {
      query: jest.fn((sql: string, parameters?: unknown[]) =>
        Promise.resolve(queryResult(sql, parameters)),
      ),
      findOne: jest.fn(() => Promise.resolve(playlist)),
      find: jest.fn(() => Promise.resolve(entryRows)),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: PLAYLIST_ID }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    ownership = {
      listUploadablePersonas: jest.fn().mockResolvedValue([{ id: PERSONA_ID }]),
    };
    playlistReads = {
      getPlaylist: jest.fn().mockResolvedValue({ id: PLAYLIST_ID }),
      playableTrackIds: jest
        .fn()
        .mockResolvedValue(new Set([TRACK_A, TRACK_B, TRACK_C])),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
    };
    service = new StudioPlaylistWritesService(
      dataSource as unknown as DataSource,
      ownership as unknown as StudioOwnershipService,
      playlistReads as unknown as StudioPlaylistReadsService,
    );
  });

  describe('create', () => {
    it('creates a playlist under the per-member lock and answers the owner view', async () => {
      await service.create(OWNER_ID, {
        name: 'Night bus',
        visibility: StudioPlaylistVisibility.Private,
        description: '   ',
      });

      expect(manager.query.mock.calls[0]).toEqual([
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`studio_playlist_create:${OWNER_ID}`],
      ]);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER_ID,
          name: 'Night bus',
          description: null,
          visibility: 'private',
          creditSubprofileId: null,
          isCreditedToPersona: false,
        }),
      );
      expect(playlistReads.getPlaylist).toHaveBeenCalledWith(
        OWNER_ID,
        PLAYLIST_ID,
      );
    });

    it('stores a persona credit with its flag', async () => {
      await service.create(OWNER_ID, {
        name: 'Night bus',
        visibility: StudioPlaylistVisibility.Public,
        creditSubprofileId: PERSONA_ID,
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
    });

    it('refuses a persona the member cannot show a playlist as', async () => {
      ownership.listUploadablePersonas.mockResolvedValue([]);
      expect(
        await codeOf(
          service.create(OWNER_ID, {
            name: 'Night bus',
            visibility: StudioPlaylistVisibility.Public,
            creditSubprofileId: PERSONA_ID,
          }),
        ),
      ).toBe('studio_playlist_credit_not_allowed');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('takes the key share on the persona after the per-member lock and checks the credit under it', async () => {
      await service.create(OWNER_ID, {
        name: 'Night bus',
        visibility: StudioPlaylistVisibility.Public,
        creditSubprofileId: PERSONA_ID,
      });

      expect(statementsMatching(LOCK_CREDIT_PERSONA_SQL)).toEqual([
        [PERSONA_ID],
      ]);
      const advisoryLockOrder = firstCallOrderOf(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
      );
      const personaLockOrder = firstCallOrderOf(LOCK_CREDIT_PERSONA_SQL);
      const creditCheckOrder =
        ownership.listUploadablePersonas.mock.invocationCallOrder[0] ?? 0;
      const saveOrder = manager.save.mock.invocationCallOrder[0] ?? 0;
      expect(advisoryLockOrder).toBeLessThan(personaLockOrder);
      expect(personaLockOrder).toBeLessThan(creditCheckOrder);
      expect(creditCheckOrder).toBeLessThan(saveOrder);
    });

    it('reads the uploadable personas on the transaction that holds the key share', async () => {
      await service.create(OWNER_ID, {
        name: 'Night bus',
        visibility: StudioPlaylistVisibility.Public,
        creditSubprofileId: PERSONA_ID,
      });
      expect(ownership.listUploadablePersonas).toHaveBeenCalledWith(
        OWNER_ID,
        manager,
      );
    });

    it('refuses a credit whose persona row is gone', async () => {
      isPersonaRowPresent = false;
      expect(
        await codeOf(
          service.create(OWNER_ID, {
            name: 'Night bus',
            visibility: StudioPlaylistVisibility.Public,
            creditSubprofileId: PERSONA_ID,
          }),
        ),
      ).toBe('studio_playlist_credit_not_allowed');
      expect(ownership.listUploadablePersonas).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('matches a persona id in any letter case and stores it lowercased', async () => {
      ownership.listUploadablePersonas.mockResolvedValue([
        { id: PERSONA_ID.toUpperCase() },
      ]);
      await service.create(OWNER_ID, {
        name: 'Night bus',
        visibility: StudioPlaylistVisibility.Public,
        creditSubprofileId: PERSONA_ID.toUpperCase(),
      });
      expect(statementsMatching(LOCK_CREDIT_PERSONA_SQL)).toEqual([
        [PERSONA_ID],
      ]);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ creditSubprofileId: PERSONA_ID }),
      );
    });

    it('refuses a 101st playlist', async () => {
      manager.count.mockResolvedValue(100);
      expect(
        await codeOf(
          service.create(OWNER_ID, {
            name: 'One more',
            visibility: StudioPlaylistVisibility.Private,
          }),
        ),
      ).toBe('studio_playlist_limit');
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('owner-only writes', () => {
    it('answers 404 to a member who does not own the playlist, even one they can see', async () => {
      await expect(
        service.update(OTHER_MEMBER_ID, PLAYLIST_ID, { name: 'Mine now' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.remove(OTHER_MEMBER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('answers 404 for a playlist that does not exist', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.reorder(OWNER_ID, PLAYLIST_ID, { entryIds: [ENTRY_ONE] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('locks the playlist row for the write', async () => {
      await service.update(OWNER_ID, PLAYLIST_ID, { name: 'Night bus 2' });
      expect(manager.findOne).toHaveBeenCalledWith(StudioPlaylist, {
        where: { id: PLAYLIST_ID },
        lock: { mode: 'pessimistic_write' },
      });
    });
  });

  describe('update', () => {
    it('changes the name, clears the description and moves the credit back to the member', async () => {
      playlist = playlistRow({
        description: 'Old',
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });

      await service.update(OWNER_ID, PLAYLIST_ID, {
        name: 'Night bus 2',
        description: null,
        creditSubprofileId: null,
      });

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Night bus 2',
          description: null,
          creditSubprofileId: null,
          isCreditedToPersona: false,
          visibility: 'public',
        }),
      );
    });

    it('turns a persona credit that stopped standing into a private member credit on any edit', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;

      await service.update(OWNER_ID, PLAYLIST_ID, { name: 'Renamed' });

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Renamed',
          creditSubprofileId: null,
          isCreditedToPersona: false,
          visibility: 'private',
        }),
      );
    });

    it('keeps the visibility the owner picks in the same edit that clears a broken credit', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;

      await service.update(OWNER_ID, PLAYLIST_ID, {
        visibility: StudioPlaylistVisibility.Connections,
      });

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isCreditedToPersona: false,
          visibility: 'connections',
        }),
      );
    });

    it('takes the key share on a newly credited persona before it locks the playlist', async () => {
      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: PERSONA_ID,
      });

      expect(statementsMatching(LOCK_CREDIT_PERSONA_SQL)).toEqual([
        [PERSONA_ID],
      ]);
      const personaLockOrder = firstCallOrderOf(LOCK_CREDIT_PERSONA_SQL);
      const creditCheckOrder =
        ownership.listUploadablePersonas.mock.invocationCallOrder[0] ?? 0;
      const playlistLockOrder =
        manager.findOne.mock.invocationCallOrder[0] ?? 0;
      expect(personaLockOrder).toBeLessThan(creditCheckOrder);
      expect(creditCheckOrder).toBeLessThan(playlistLockOrder);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
    });

    it('refuses a new credit whose persona row is gone and leaves the playlist unlocked', async () => {
      isPersonaRowPresent = false;
      expect(
        await codeOf(
          service.update(OWNER_ID, PLAYLIST_ID, {
            creditSubprofileId: PERSONA_ID,
          }),
        ),
      ).toBe('studio_playlist_credit_not_allowed');
      expect(manager.findOne).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses a new credit the member cannot show a playlist as', async () => {
      ownership.listUploadablePersonas.mockResolvedValue([]);
      expect(
        await codeOf(
          service.update(OWNER_ID, PLAYLIST_ID, {
            creditSubprofileId: PERSONA_ID,
          }),
        ),
      ).toBe('studio_playlist_credit_not_allowed');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('stores a new credit lowercased', async () => {
      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: PERSONA_ID.toUpperCase(),
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ creditSubprofileId: PERSONA_ID }),
      );
    });

    it('locks no persona when the edit leaves the credit alone or moves it back to the member', async () => {
      await service.update(OWNER_ID, PLAYLIST_ID, { name: 'Renamed' });
      await service.update(OWNER_ID, PLAYLIST_ID, { creditSubprofileId: null });
      expect(statementsMatching(LOCK_CREDIT_PERSONA_SQL)).toEqual([]);
    });

    it('reads whether a persona credit stands on an edit alone', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      entryRows = [{ id: ENTRY_ONE, trackId: TRACK_A }];
      const standingReads = (): number =>
        manager.query.mock.calls.filter(([statement]) =>
          (statement as string).includes('AS "is_standing"'),
        ).length;

      await service.addTracks(OWNER_ID, PLAYLIST_ID, { trackIds: [TRACK_B] });
      await service.reorder(OWNER_ID, PLAYLIST_ID, { entryIds: [ENTRY_ONE] });
      await service.removeEntry(OWNER_ID, PLAYLIST_ID, ENTRY_ONE);
      await service.remove(OWNER_ID, PLAYLIST_ID);
      expect(standingReads()).toBe(0);

      await service.update(OWNER_ID, PLAYLIST_ID, { name: 'Renamed' });
      expect(standingReads()).toBe(1);
    });
  });

  describe('addTracks', () => {
    it('appends playable tracks in request order, skipping repeats and tracks already present', async () => {
      entryRows = [{ id: ENTRY_ONE, trackId: TRACK_A }];

      await service.addTracks(OWNER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_B, TRACK_A, TRACK_C, TRACK_B],
      });

      expect(playlistReads.playableTrackIds).toHaveBeenCalledWith(OWNER_ID, [
        TRACK_B,
        TRACK_A,
        TRACK_C,
      ]);
      expect(statementsMatching(RENUMBER_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID],
      ]);
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID, [TRACK_B, TRACK_C], 1],
      ]);
      expect(statementsMatching(TOUCH_PLAYLIST_SQL)).toEqual([[PLAYLIST_ID]]);
    });

    it('writes nothing when every track is already in the playlist', async () => {
      entryRows = [{ id: ENTRY_ONE, trackId: TRACK_A }];
      await service.addTracks(OWNER_ID, PLAYLIST_ID, { trackIds: [TRACK_A] });
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
      expect(playlistReads.getPlaylist).toHaveBeenCalled();
    });

    it('refuses the whole add when one track cannot be played', async () => {
      playlistReads.playableTrackIds.mockResolvedValue(new Set([TRACK_A]));
      expect(
        await codeOf(
          service.addTracks(OWNER_ID, PLAYLIST_ID, {
            trackIds: [TRACK_A, TRACK_B],
          }),
        ),
      ).toBe('studio_playlist_track_unavailable');
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('refuses an add that would take the playlist past 500 entries, unavailable ones counted', async () => {
      entryRows = Array.from({ length: 499 }, (_unused, index) => ({
        id: `entry-${index}`,
        trackId: index % 2 === 0 ? null : `track-${index}`,
      }));
      expect(
        await codeOf(
          service.addTracks(OWNER_ID, PLAYLIST_ID, {
            trackIds: [TRACK_A, TRACK_B],
          }),
        ),
      ).toBe('studio_playlist_track_limit');
    });

    it('takes the key share on the added tracks after the playlist lock and before the renumber', async () => {
      entryRows = [{ id: ENTRY_ONE, trackId: TRACK_A }];

      await service.addTracks(OWNER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_B, TRACK_A, TRACK_C],
      });

      expect(statementsMatching(LOCK_ADDED_TRACKS_SQL)).toEqual([
        [[TRACK_B, TRACK_C]],
      ]);
      const playlistLockOrder =
        manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const trackLockOrder = firstCallOrderOf(LOCK_ADDED_TRACKS_SQL);
      const renumberOrder = firstCallOrderOf(RENUMBER_PLAYLIST_ENTRIES_SQL);
      expect(playlistLockOrder).toBeLessThan(trackLockOrder);
      expect(trackLockOrder).toBeLessThan(renumberOrder);
    });

    it('refuses the whole add when a track is gone by the time it is locked', async () => {
      missingTrackIds = new Set([TRACK_C]);
      expect(
        await codeOf(
          service.addTracks(OWNER_ID, PLAYLIST_ID, {
            trackIds: [TRACK_B, TRACK_C],
          }),
        ),
      ).toBe('studio_playlist_track_unavailable');
      expect(statementsMatching(RENUMBER_PLAYLIST_ENTRIES_SQL)).toEqual([]);
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('skips a present track sent in capitals', async () => {
      entryRows = [{ id: ENTRY_ONE, trackId: TRACK_B }];
      await service.addTracks(OWNER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_B.toUpperCase()],
      });
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('runs the whole add once more after a Postgres deadlock', async () => {
      const deadlock = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      dataSource.transaction.mockImplementationOnce(() =>
        Promise.reject(deadlock),
      );

      await service.addTracks(OWNER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_A],
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID, [TRACK_A], 0],
      ]);
      expect(playlistReads.getPlaylist).toHaveBeenCalledWith(
        OWNER_ID,
        PLAYLIST_ID,
      );
    });

    it('keeps the lock order on the retry: playlist, added tracks, renumber', async () => {
      dataSource.transaction.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('deadlock detected'), {
            driverError: { code: '40P01' },
          }),
        ),
      );

      await service.addTracks(OWNER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_A],
      });

      const playlistLockOrder =
        manager.findOne.mock.invocationCallOrder[0] ?? 0;
      expect(playlistLockOrder).toBeGreaterThan(0);
      expect(firstCallOrderOf(LOCK_ADDED_TRACKS_SQL)).toBeGreaterThan(
        playlistLockOrder,
      );
      expect(firstCallOrderOf(RENUMBER_PLAYLIST_ENTRIES_SQL)).toBeGreaterThan(
        firstCallOrderOf(LOCK_ADDED_TRACKS_SQL),
      );
    });

    it('answers the second deadlock with the error and tries no third time', async () => {
      const deadlock = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      dataSource.transaction.mockRejectedValue(deadlock);

      await expect(
        service.addTracks(OWNER_ID, PLAYLIST_ID, { trackIds: [TRACK_A] }),
      ).rejects.toBe(deadlock);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(playlistReads.getPlaylist).not.toHaveBeenCalled();
    });

    it('retries nothing else', async () => {
      playlistReads.playableTrackIds.mockResolvedValue(new Set());
      expect(
        await codeOf(
          service.addTracks(OWNER_ID, PLAYLIST_ID, { trackIds: [TRACK_A] }),
        ),
      ).toBe('studio_playlist_track_unavailable');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('isDeadlockError', () => {
    it.each([
      ['a top-level SQLSTATE', { code: '40P01' }, true],
      ['a wrapped driver error', { driverError: { code: '40P01' } }, true],
      ['a unique violation', { code: '23505' }, false],
      ['no error at all', null, false],
    ])('reads %s', (_label, error, isDeadlock) => {
      expect(isDeadlockError(error)).toBe(isDeadlock);
    });
  });

  describe('removeEntry', () => {
    it('deletes the entry, renumbers the rest and touches the playlist', async () => {
      await service.removeEntry(OWNER_ID, PLAYLIST_ID, ENTRY_ONE);

      expect(manager.delete).toHaveBeenCalledWith(StudioPlaylistTrack, {
        id: ENTRY_ONE,
        playlistId: PLAYLIST_ID,
      });
      expect(statementsMatching(RENUMBER_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID],
      ]);
      expect(statementsMatching(TOUCH_PLAYLIST_SQL)).toEqual([[PLAYLIST_ID]]);
    });

    it('answers 404 for an entry of another playlist', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.removeEntry(OWNER_ID, PLAYLIST_ID, ENTRY_ONE),
      ).rejects.toThrow('Entry not found');
      expect(statementsMatching(RENUMBER_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });
  });

  describe('reorder', () => {
    it('rewrites every position in one statement', async () => {
      entryRows = [{ id: ENTRY_ONE }, { id: ENTRY_TWO }];

      await service.reorder(OWNER_ID, PLAYLIST_ID, {
        entryIds: [ENTRY_TWO, ENTRY_ONE],
      });

      expect(statementsMatching(REORDER_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID, [ENTRY_TWO, ENTRY_ONE], [1, 2]],
      ]);
    });

    it('locks the playlist before it reads the entries', async () => {
      entryRows = [{ id: ENTRY_ONE }, { id: ENTRY_TWO }];
      await service.reorder(OWNER_ID, PLAYLIST_ID, {
        entryIds: [ENTRY_TWO, ENTRY_ONE],
      });
      const lockOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const readOrder = manager.find.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeLessThan(readOrder);
    });

    it('answers a mismatch when an entry was removed first', async () => {
      entryRows = [{ id: ENTRY_ONE }];
      expect(
        await codeOf(
          service.reorder(OWNER_ID, PLAYLIST_ID, {
            entryIds: [ENTRY_TWO, ENTRY_ONE],
          }),
        ),
      ).toBe('studio_playlist_order_mismatch');
      expect(statementsMatching(REORDER_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('answers a mismatch for a repeated entry', async () => {
      entryRows = [{ id: ENTRY_ONE }, { id: ENTRY_TWO }];
      expect(
        await codeOf(
          service.reorder(OWNER_ID, PLAYLIST_ID, {
            entryIds: [ENTRY_ONE, ENTRY_ONE],
          }),
        ),
      ).toBe('studio_playlist_order_mismatch');
    });
  });

  it('deletes an owned playlist, its entries following by cascade', async () => {
    await service.remove(OWNER_ID, PLAYLIST_ID);
    expect(manager.delete).toHaveBeenCalledWith(StudioPlaylist, {
      id: PLAYLIST_ID,
    });
  });
});
