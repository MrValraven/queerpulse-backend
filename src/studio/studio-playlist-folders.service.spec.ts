import { HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioPlaylistFolder } from './entities/studio-playlist-folder.entity';
import {
  FILE_PLAYLIST_SQL,
  FOLDER_VIEWER_PARAMETER,
  LOCK_MEMBER_FOLDERS_SQL,
  PLAYLIST_FILEABLE_BY_MEMBER_SQL,
  RENUMBER_FOLDERS_SQL,
  StudioPlaylistFoldersService,
  UNFILE_PLAYLIST_SQL,
} from './studio-playlist-folders.service';
import {
  creditStandsSql,
  personaCreatorBlockExemptSql,
  playlistOpenToViewerSql,
  playlistOwnerIsActiveSql,
} from './studio-playlist-visibility';

const createdAt = new Date('2026-10-21T12:00:00.000Z');

const folder = (
  overrides: Partial<StudioPlaylistFolder> = {},
): StudioPlaylistFolder => ({
  id: 'folder-1',
  userId: 'member-1',
  name: 'Late nights',
  position: 0,
  createdAt,
  ...overrides,
});

/** The HTTP status and Studio code an error carries. */
function refusalOf(error: unknown): { status: number; code: unknown } {
  const httpError = error as {
    getStatus: () => number;
    getResponse: () => { code?: unknown };
  };
  return {
    status: httpError.getStatus(),
    code: httpError.getResponse().code,
  };
}

/** A chainable stand-in for TypeORM's SelectQueryBuilder that records the
 *  conditions it was given and answers with the rows a test sets. */
function fakeQueryBuilder(answer: { rawOne?: unknown; rawMany?: unknown[] }) {
  const conditions: { sql: string; parameters?: Record<string, unknown> }[] =
    [];
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'orderBy',
    'addOrderBy',
  ])
    queryBuilder[method] = jest.fn(() => queryBuilder);
  queryBuilder.andWhere = jest.fn(
    (sql: string, parameters?: Record<string, unknown>) => {
      conditions.push({ sql, parameters });
      return queryBuilder;
    },
  );
  queryBuilder.getRawOne = jest.fn().mockResolvedValue(answer.rawOne);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(answer.rawMany ?? []);
  return { queryBuilder, conditions };
}

describe('StudioPlaylistFoldersService', () => {
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let blockFilter: { excludeBlocked: jest.Mock };
  let service: StudioPlaylistFoldersService;

  /** Every query builder the service asks for answers like this one. */
  const answerQueries = (answer: { rawOne?: unknown; rawMany?: unknown[] }) => {
    const fake = fakeQueryBuilder(answer);
    manager.createQueryBuilder.mockReturnValue(fake.queryBuilder);
    return fake;
  };

  beforeEach(() => {
    manager = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(
        (_entity: unknown, value: Partial<StudioPlaylistFolder>) => value,
      ),
      save: jest.fn((value: Partial<StudioPlaylistFolder>) =>
        Promise.resolve({ id: 'folder-new', createdAt, ...value }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    answerQueries({});
    blockFilter = { excludeBlocked: jest.fn() };
    const dataSource = {
      manager,
      transaction: jest.fn((work: (inner: typeof manager) => unknown) =>
        work(manager),
      ),
    };
    service = new StudioPlaylistFoldersService(
      dataSource as unknown as DataSource,
      blockFilter as unknown as BlockFilterService,
    );
  });

  describe('the fileable rule', () => {
    it('needs the playlist open to the member by link, then ownership, an editor seat or a save', () => {
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        playlistOpenToViewerSql('playlist', FOLDER_VIEWER_PARAMETER),
      );
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        `"playlist"."user_id" = :${FOLDER_VIEWER_PARAMETER}`,
      );
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        `"viewer_active_editor_row"."status" = 'active'`,
      );
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        creditStandsSql('playlist'),
      );
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        playlistOwnerIsActiveSql('playlist'),
      );
      expect(PLAYLIST_FILEABLE_BY_MEMBER_SQL).toContain(
        `"folder_saved"."subject_type" = 'studio_playlist'`,
      );
    });
  });

  describe('list', () => {
    it('returns the folders in order with the playlists filed in each', async () => {
      manager.find.mockResolvedValue([
        folder(),
        folder({ id: 'folder-2', name: 'Road trips', position: 1 }),
      ]);
      const { conditions } = answerQueries({
        rawMany: [
          { folder_id: 'folder-1', playlist_id: 'playlist-a' },
          { folder_id: 'folder-1', playlist_id: 'playlist-b' },
        ],
      });
      const result = await service.list('member-1');
      expect(manager.find).toHaveBeenCalledWith(StudioPlaylistFolder, {
        where: { userId: 'member-1' },
        order: { position: 'ASC', id: 'ASC' },
      });
      expect(conditions).toContainEqual({
        sql: PLAYLIST_FILEABLE_BY_MEMBER_SQL,
        parameters: { [FOLDER_VIEWER_PARAMETER]: 'member-1' },
      });
      expect(result.items).toEqual([
        {
          id: 'folder-1',
          name: 'Late nights',
          position: 0,
          createdAt: createdAt.toISOString(),
          playlistIds: ['playlist-a', 'playlist-b'],
        },
        {
          id: 'folder-2',
          name: 'Road trips',
          position: 1,
          createdAt: createdAt.toISOString(),
          playlistIds: [],
        },
      ]);
    });

    it('filters blocks either way on the owner and on the persona creator', async () => {
      manager.find.mockResolvedValue([folder()]);
      const { queryBuilder } = answerQueries({ rawMany: [] });
      await service.list('member-1');
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'member-1',
        '"playlist"."user_id"',
      );
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        queryBuilder,
        'member-1',
        expect.stringContaining('"credit_creator"'),
        {
          unless: personaCreatorBlockExemptSql(
            'playlist',
            FOLDER_VIEWER_PARAMETER,
          ),
        },
      );
    });

    it('leaves out a saved playlist that went private: the read finds no row for it', async () => {
      manager.find.mockResolvedValue([folder()]);
      // The filed row for the now-private playlist fails the fileable rule
      // in SQL, so the read answers without it.
      answerQueries({ rawMany: [] });
      const result = await service.list('member-1');
      expect(result.items[0]?.playlistIds).toEqual([]);
    });
  });

  describe('create', () => {
    it('places the new folder after the last one, under the member lock', async () => {
      manager.find.mockResolvedValue([folder({ position: 3 })]);
      const created = await service.create('member-1', { name: 'Road trips' });
      expect(manager.query).toHaveBeenCalledWith(LOCK_MEMBER_FOLDERS_SQL, [
        'member-1',
      ]);
      expect(manager.create).toHaveBeenCalledWith(StudioPlaylistFolder, {
        userId: 'member-1',
        name: 'Road trips',
        position: 4,
      });
      expect(created).toMatchObject({
        id: 'folder-new',
        name: 'Road trips',
        position: 4,
        playlistIds: [],
      });
    });

    it('files a playlist in the new folder in the same transaction', async () => {
      answerQueries({ rawOne: { id: 'playlist-a' } });
      const created = await service.create('member-1', {
        name: 'Road trips',
        playlistId: 'playlist-a',
      });
      expect(manager.query).toHaveBeenCalledWith(FILE_PLAYLIST_SQL, [
        'member-1',
        'playlist-a',
        'folder-new',
      ]);
      expect(created.playlistIds).toEqual(['playlist-a']);
    });

    it('refuses the whole create when the playlist cannot be filed', async () => {
      answerQueries({ rawOne: undefined });
      const error: unknown = await service
        .create('member-1', { name: 'Road trips', playlistId: 'playlist-z' })
        .catch((caught: unknown) => caught);
      expect(refusalOf(error).code).toBe(
        'studio_playlist_folder_playlist_unavailable',
      );
      expect(manager.query).not.toHaveBeenCalledWith(
        FILE_PLAYLIST_SQL,
        expect.anything(),
      );
    });

    it('refuses a folder past the cap with studio_playlist_folder_limit', async () => {
      manager.find.mockResolvedValue(
        Array.from({ length: 50 }, (_, index) =>
          folder({ id: `folder-${index}`, position: index }),
        ),
      );
      const error: unknown = await service
        .create('member-1', { name: 'One more' })
        .catch((caught: unknown) => caught);
      expect(refusalOf(error)).toEqual({
        status: HttpStatus.CONFLICT,
        code: 'studio_playlist_folder_limit',
      });
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('renames a folder the member owns', async () => {
      manager.find.mockResolvedValue([folder()]);
      const updated = await service.update('member-1', 'folder-1', {
        name: 'After hours',
      });
      expect(manager.update).toHaveBeenCalledWith(
        StudioPlaylistFolder,
        { id: 'folder-1' },
        { name: 'After hours' },
      );
      expect(updated.name).toBe('After hours');
    });

    it('moves a folder and renumbers the rest in one statement', async () => {
      manager.find.mockResolvedValue([
        folder({ id: 'folder-a', position: 0 }),
        folder({ id: 'folder-b', position: 1 }),
        folder({ id: 'folder-c', position: 2 }),
      ]);
      const updated = await service.update('member-1', 'folder-c', {
        position: 0,
      });
      expect(manager.query).toHaveBeenCalledWith(RENUMBER_FOLDERS_SQL, [
        ['folder-c', 'folder-a', 'folder-b'],
      ]);
      expect(updated.position).toBe(0);
    });

    it('answers 404 for a folder the caller does not own', async () => {
      manager.find.mockResolvedValue([folder()]);
      const error: unknown = await service
        .update('member-1', 'folder-elsewhere', { name: 'Mine now' })
        .catch((caught: unknown) => caught);
      expect(refusalOf(error)).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'studio_playlist_folder_not_found',
      });
    });
  });

  describe('remove', () => {
    it('deletes only a folder the caller owns', async () => {
      await service.remove('member-1', 'folder-1');
      expect(manager.delete).toHaveBeenCalledWith(StudioPlaylistFolder, {
        id: 'folder-1',
        userId: 'member-1',
      });
    });

    it('answers 404 when nothing was deleted', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });
      const error: unknown = await service
        .remove('member-1', 'folder-1')
        .catch((caught: unknown) => caught);
      expect(refusalOf(error).code).toBe('studio_playlist_folder_not_found');
    });
  });

  describe('movePlaylist', () => {
    it('files a playlist the member may file', async () => {
      manager.findOne.mockResolvedValue(folder());
      const { conditions } = answerQueries({ rawOne: { id: 'playlist-a' } });
      await service.movePlaylist('member-1', 'playlist-a', 'folder-1');
      expect(manager.findOne).toHaveBeenCalledWith(StudioPlaylistFolder, {
        where: { id: 'folder-1', userId: 'member-1' },
        lock: { mode: 'pessimistic_read' },
      });
      expect(conditions).toContainEqual({
        sql: PLAYLIST_FILEABLE_BY_MEMBER_SQL,
        parameters: { [FOLDER_VIEWER_PARAMETER]: 'member-1' },
      });
      expect(manager.query).toHaveBeenCalledWith(FILE_PLAYLIST_SQL, [
        'member-1',
        'playlist-a',
        'folder-1',
      ]);
    });

    it('answers a saved playlist that went private with 404, the same as one that never existed', async () => {
      manager.findOne.mockResolvedValue(folder());
      // Saved, now private: the save stays, but the playlist is no longer
      // open to the member by link, so the fileable read finds nothing.
      answerQueries({ rawOne: undefined });
      const error: unknown = await service
        .movePlaylist('member-1', 'playlist-now-private', 'folder-1')
        .catch((caught: unknown) => caught);
      expect(refusalOf(error)).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'studio_playlist_folder_playlist_unavailable',
      });
      expect(manager.query).not.toHaveBeenCalledWith(
        FILE_PLAYLIST_SQL,
        expect.anything(),
      );
    });

    it('refuses a folder another member owns', async () => {
      const error: unknown = await service
        .movePlaylist('member-1', 'playlist-a', 'folder-elsewhere')
        .catch((caught: unknown) => caught);
      expect(refusalOf(error).code).toBe('studio_playlist_folder_not_found');
    });

    it('puts a playlist back at the top level with a null folder', async () => {
      await service.movePlaylist('member-1', 'playlist-a', null);
      expect(manager.query).toHaveBeenCalledWith(UNFILE_PLAYLIST_SQL, [
        'member-1',
        'playlist-a',
      ]);
      expect(manager.findOne).not.toHaveBeenCalled();
    });
  });
});
