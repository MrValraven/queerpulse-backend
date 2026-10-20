import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
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
  EDITORS_UNFIT_FOR_CREDIT_SQL,
  LOCK_ADDED_TRACKS_SQL,
  LOCK_CREDIT_PERSONA_SQL,
  READ_PLAYLIST_OWNER_SQL,
  RENUMBER_PLAYLIST_ENTRIES_SQL,
  REORDER_PLAYLIST_ENTRIES_SQL,
  StudioPlaylistWritesService,
  TOUCH_PLAYLIST_SQL,
  isDeadlockError,
} from './studio-playlist-writes.service';
import { END_EDITORS_ON_PLAYLIST_SQL } from './studio-playlist-editor-endings';
import { LOCK_ACTIVE_EDITOR_ROW_SQL } from './studio-playlist-roles';
import { creditStandsSql } from './studio-playlist-visibility';

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
  let activeEditorIds: Set<string>;
  let unfitEditorRows: { user_id: string }[];
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
  let playlistReads: {
    getPlaylist: jest.Mock;
    playableTrackIds: jest.Mock;
    isOpenToViewer: jest.Mock;
    peopleByUserIds: jest.Mock;
  };
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
    if (sql === READ_PLAYLIST_OWNER_SQL) {
      return [{ user_id: playlist.userId }];
    }
    if (sql === LOCK_ACTIVE_EDITOR_ROW_SQL) {
      // The statement admits an editor only while the playlist's credit
      // stands, so a broken persona credit answers no row.
      const isCreditHolding = !playlist.isCreditedToPersona || isCreditStanding;
      return isCreditHolding && activeEditorIds.has(parameters[1] as string)
        ? [{ id: 'editor-row-1' }]
        : [];
    }
    if (sql === EDITORS_UNFIT_FOR_CREDIT_SQL) {
      return unfitEditorRows;
    }
    if (sql === END_EDITORS_ON_PLAYLIST_SQL) {
      return [];
    }
    return undefined;
  };

  beforeEach(() => {
    playlist = playlistRow();
    entryRows = [];
    isCreditStanding = true;
    isPersonaRowPresent = true;
    missingTrackIds = new Set();
    activeEditorIds = new Set();
    unfitEditorRows = [];
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
      isOpenToViewer: jest.fn().mockResolvedValue(false),
      peopleByUserIds: jest.fn((userIds: string[]) =>
        Promise.resolve(
          new Map(
            userIds.map((userId) => [
              userId,
              {
                slug: `slug-${userId}`,
                displayName: 'Member',
                avatarUrl: null,
              },
            ]),
          ),
        ),
      ),
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
    it('answers 404 to a member who holds no role on a playlist they cannot open', async () => {
      await expect(
        service.update(OTHER_MEMBER_ID, PLAYLIST_ID, { name: 'Mine now' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.remove(OTHER_MEMBER_ID, PLAYLIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await codeOf(service.remove(OTHER_MEMBER_ID, PLAYLIST_ID))).toBe(
        'studio_playlist_not_found',
      );
      expect(playlistReads.isOpenToViewer).toHaveBeenCalledWith(
        OTHER_MEMBER_ID,
        PLAYLIST_ID,
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('answers 403 owner only to a member who can open the playlist and holds no role', async () => {
      playlistReads.isOpenToViewer.mockResolvedValue(true);
      await expect(
        service.addTracks(OTHER_MEMBER_ID, PLAYLIST_ID, {
          trackIds: [TRACK_A],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await codeOf(service.remove(OTHER_MEMBER_ID, PLAYLIST_ID))).toBe(
        'studio_playlist_owner_only',
      );
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('answers a missing playlist with the playlist code', async () => {
      manager.findOne.mockResolvedValue(null);
      expect(
        await codeOf(
          service.reorder(OWNER_ID, PLAYLIST_ID, { entryIds: [ENTRY_ONE] }),
        ),
      ).toBe('studio_playlist_not_found');
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
        [PLAYLIST_ID, [TRACK_B, TRACK_C], 1, OWNER_ID],
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
        [PLAYLIST_ID, [TRACK_A], 0, OWNER_ID],
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
      expect(
        await codeOf(service.removeEntry(OWNER_ID, PLAYLIST_ID, ENTRY_ONE)),
      ).toBe('studio_playlist_entry_not_found');
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

  describe('editors', () => {
    beforeEach(() => {
      activeEditorIds = new Set([OTHER_MEMBER_ID]);
      playlistReads.isOpenToViewer.mockResolvedValue(true);
    });

    it('lets an active editor rename and describe the playlist and answers with their view', async () => {
      await service.update(OTHER_MEMBER_ID, PLAYLIST_ID, {
        name: 'Night bus 2',
        description: 'For the N2',
      });

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Night bus 2',
          description: 'For the N2',
        }),
      );
      expect(statementsMatching(LOCK_ACTIVE_EDITOR_ROW_SQL)).toEqual([
        [PLAYLIST_ID, OTHER_MEMBER_ID, OWNER_ID],
      ]);
      expect(playlistReads.getPlaylist).toHaveBeenCalledWith(
        OTHER_MEMBER_ID,
        PLAYLIST_ID,
      );
    });

    it('refuses an editor a visibility change with 403 before any lock', async () => {
      expect(
        await codeOf(
          service.update(OTHER_MEMBER_ID, PLAYLIST_ID, {
            visibility: StudioPlaylistVisibility.Private,
          }),
        ),
      ).toBe('studio_playlist_owner_only');
      expect(manager.findOne).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses an editor a credit change with 403 before the persona key share', async () => {
      expect(
        await codeOf(
          service.update(OTHER_MEMBER_ID, PLAYLIST_ID, {
            creditSubprofileId: PERSONA_ID,
          }),
        ),
      ).toBe('studio_playlist_owner_only');
      expect(statementsMatching(LOCK_CREDIT_PERSONA_SQL)).toEqual([]);
      expect(ownership.listUploadablePersonas).not.toHaveBeenCalled();
      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('records the editor as the member who added the tracks', async () => {
      await service.addTracks(OTHER_MEMBER_ID, PLAYLIST_ID, {
        trackIds: [TRACK_A],
      });
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID, [TRACK_A], 0, OTHER_MEMBER_ID],
      ]);
      expect(playlistReads.playableTrackIds).toHaveBeenCalledWith(
        OTHER_MEMBER_ID,
        [TRACK_A],
      );
    });

    it('answers 404 to an editor adding to a playlist whose persona credit stopped standing and writes nothing', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;
      playlistReads.isOpenToViewer.mockResolvedValue(false);

      expect(
        await codeOf(
          service.addTracks(OTHER_MEMBER_ID, PLAYLIST_ID, {
            trackIds: [TRACK_A],
          }),
        ),
      ).toBe('studio_playlist_not_found');
      expect(LOCK_ACTIVE_EDITOR_ROW_SQL).toContain(creditStandsSql('playlist'));
      expect(statementsMatching(LOCK_ACTIVE_EDITOR_ROW_SQL)).toEqual([
        [PLAYLIST_ID, OTHER_MEMBER_ID, OWNER_ID],
      ]);
      expect(statementsMatching(APPEND_PLAYLIST_ENTRIES_SQL)).toEqual([]);
      expect(statementsMatching(TOUCH_PLAYLIST_SQL)).toEqual([]);
    });

    it('leaves a broken persona credit to the owner when an editor renames', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;
      playlistReads.isOpenToViewer.mockResolvedValue(false);

      expect(
        await codeOf(
          service.update(OTHER_MEMBER_ID, PLAYLIST_ID, { name: 'Renamed' }),
        ),
      ).toBe('studio_playlist_not_found');
      const standingReads = manager.query.mock.calls.filter(([statement]) =>
        (statement as string).includes('AS "is_standing"'),
      );
      expect(standingReads).toEqual([]);
      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('lets an editor remove an entry and reorder with the full entry list', async () => {
      await service.removeEntry(OTHER_MEMBER_ID, PLAYLIST_ID, ENTRY_ONE);
      expect(manager.delete).toHaveBeenCalledWith(StudioPlaylistTrack, {
        id: ENTRY_ONE,
        playlistId: PLAYLIST_ID,
      });

      entryRows = [{ id: ENTRY_ONE }, { id: ENTRY_TWO }];
      await service.reorder(OTHER_MEMBER_ID, PLAYLIST_ID, {
        entryIds: [ENTRY_TWO, ENTRY_ONE],
      });
      expect(statementsMatching(REORDER_PLAYLIST_ENTRIES_SQL)).toEqual([
        [PLAYLIST_ID, [ENTRY_TWO, ENTRY_ONE], [1, 2]],
      ]);
    });

    it('answers the order mismatch when another editor removed an entry first', async () => {
      // Editor B removed ENTRY_TWO; editor A still sends the old order.
      entryRows = [{ id: ENTRY_ONE }];
      expect(
        await codeOf(
          service.reorder(OTHER_MEMBER_ID, PLAYLIST_ID, {
            entryIds: [ENTRY_TWO, ENTRY_ONE],
          }),
        ),
      ).toBe('studio_playlist_order_mismatch');
      expect(statementsMatching(REORDER_PLAYLIST_ENTRIES_SQL)).toEqual([]);
    });

    it('answers 404 with the entry code when another editor removed the entry first', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });
      expect(
        await codeOf(
          service.removeEntry(OTHER_MEMBER_ID, PLAYLIST_ID, ENTRY_ONE),
        ),
      ).toBe('studio_playlist_entry_not_found');
    });

    it('refuses an editor the delete with 403', async () => {
      expect(await codeOf(service.remove(OTHER_MEMBER_ID, PLAYLIST_ID))).toBe(
        'studio_playlist_owner_only',
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('refuses an invitee every track write with 403', async () => {
      activeEditorIds = new Set();
      expect(
        await codeOf(
          service.addTracks(OTHER_MEMBER_ID, PLAYLIST_ID, {
            trackIds: [TRACK_A],
          }),
        ),
      ).toBe('studio_playlist_owner_only');
      expect(
        await codeOf(
          service.removeEntry(OTHER_MEMBER_ID, PLAYLIST_ID, ENTRY_ONE),
        ),
      ).toBe('studio_playlist_owner_only');
    });
  });

  describe('credit changes with editors', () => {
    const EDITOR_ID = 'f3000000-0000-4000-8000-000000000003';
    const OTHER_PERSONA_ID = 'f4000000-0000-4000-8000-000000000002';

    it('refuses a credit change that would remove editors and names them', async () => {
      unfitEditorRows = [{ user_id: EDITOR_ID }];
      let refusal: HttpException | undefined;
      try {
        await service.update(OWNER_ID, PLAYLIST_ID, {
          creditSubprofileId: PERSONA_ID,
        });
      } catch (error) {
        refusal = error as HttpException;
      }

      expect(refusal?.getStatus()).toBe(409);
      expect(refusal?.getResponse()).toEqual(
        expect.objectContaining({
          code: 'studio_playlist_credit_change_removes_editors',
          editors: [
            {
              slug: `slug-${EDITOR_ID}`,
              displayName: 'Member',
              avatarUrl: null,
            },
          ],
        }),
      );
      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([
        [PLAYLIST_ID, PERSONA_ID],
      ]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('names only the active editors in the refusal and still ends every unfit editor once confirmed', async () => {
      const INACTIVE_EDITOR_ID = 'f3000000-0000-4000-8000-000000000009';
      unfitEditorRows = [
        { user_id: EDITOR_ID },
        { user_id: INACTIVE_EDITOR_ID },
      ];
      playlistReads.peopleByUserIds.mockImplementation((userIds: string[]) =>
        Promise.resolve(
          new Map(
            userIds
              .filter((userId) => userId !== INACTIVE_EDITOR_ID)
              .map((userId) => [
                userId,
                {
                  slug: `slug-${userId}`,
                  displayName: 'Member',
                  avatarUrl: null,
                },
              ]),
          ),
        ),
      );
      let refusal: HttpException | undefined;
      try {
        await service.update(OWNER_ID, PLAYLIST_ID, {
          creditSubprofileId: PERSONA_ID,
        });
      } catch (error) {
        refusal = error as HttpException;
      }

      expect(refusal?.getStatus()).toBe(409);
      expect(refusal?.getResponse()).toEqual(
        expect.objectContaining({
          editors: [
            {
              slug: `slug-${EDITOR_ID}`,
              displayName: 'Member',
              avatarUrl: null,
            },
          ],
        }),
      );

      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: PERSONA_ID,
        confirmEditorRemoval: true,
      });
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([
        [PLAYLIST_ID, [EDITOR_ID, INACTIVE_EDITOR_ID], 'revoked'],
      ]);
    });

    it('revokes the editors a confirmed credit change removes, in the edit transaction', async () => {
      unfitEditorRows = [{ user_id: EDITOR_ID }];

      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: PERSONA_ID,
        confirmEditorRemoval: true,
      });

      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([
        [PLAYLIST_ID, [EDITOR_ID], 'revoked'],
      ]);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          creditSubprofileId: PERSONA_ID,
          isCreditedToPersona: true,
        }),
      );
    });

    it('keeps co-owners of both personas on a persona to persona change', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      ownership.listUploadablePersonas.mockResolvedValue([
        { id: PERSONA_ID },
        { id: OTHER_PERSONA_ID },
      ]);

      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: OTHER_PERSONA_ID,
      });

      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([
        [PLAYLIST_ID, OTHER_PERSONA_ID],
      ]);
      expect(EDITORS_UNFIT_FOR_CREDIT_SQL).toContain(
        `"new_credit_member"."subprofile_id" = $2::uuid`,
      );
      expect(EDITORS_UNFIT_FOR_CREDIT_SQL).toContain(
        `($2::uuid IS NULL AND "editor"."source" = 'persona_co_owner')`,
      );
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
      expect(manager.save).toHaveBeenCalled();
    });

    it('asks nothing about editors when the credit stays as it is', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      await service.update(OWNER_ID, PLAYLIST_ID, {
        creditSubprofileId: PERSONA_ID,
        visibility: StudioPlaylistVisibility.Connections,
      });
      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([]);
    });

    it('ends the co-owner editors with no confirmation when a broken credit is cleared', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;
      unfitEditorRows = [{ user_id: EDITOR_ID }];

      await service.update(OWNER_ID, PLAYLIST_ID, { name: 'Renamed' });

      expect(statementsMatching(EDITORS_UNFIT_FOR_CREDIT_SQL)).toEqual([
        [PLAYLIST_ID, null],
      ]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([
        [PLAYLIST_ID, [EDITOR_ID], 'revoked'],
      ]);
      expect(manager.save).toHaveBeenCalled();
    });
  });
});
