import { HttpException, Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import {
  asVjDate,
  buildVjLibraryChange,
  deleteVjStoredObject,
  DENSIFY_VJ_SCENES_SQL,
  DENSIFY_VJ_SETLIST_ITEMS_SQL,
  DENSIFY_VJ_SETLISTS_SQL,
  lowercaseIdOrRefuse,
  runVjTransaction,
  violatedForeignKeyConstraintOf,
  violatedUniqueConstraintOf,
} from './vj-library-kit';
import { vjError } from './vj.constants';

const PACK_ID = 'a7110000-0000-4000-8000-100000000001';
const SCENE_ID = 'a7110000-0000-4000-8000-200000000001';
const SETLIST_ID = 'a7110000-0000-4000-8000-300000000001';
const PREVIEW_KEY =
  'vj-previews/a7110000-0000-4000-8000-400000000001/a7110000-0000-4000-8000-500000000001.webm';

function uniqueViolation(constraint: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505', constraint }),
  );
}

function foreignKeyViolation(constraint: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('foreign key violation'), {
      code: '23503',
      constraint,
    }),
  );
}

/** A data source whose transaction runs `work` on a bare manager and
 *  rethrows what `work` throws. */
function dataSourceRunning(): DataSource {
  const manager = {} as EntityManager;
  return {
    transaction: jest.fn(
      (work: (transactionManager: EntityManager) => Promise<unknown>) =>
        work(manager),
    ),
  } as unknown as DataSource;
}

async function refusalCodeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (!(error instanceof HttpException)) {
      throw error;
    }
    return (error.getResponse() as Record<string, unknown>).code;
  }
}

describe('vj-library-kit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps a unique violation by constraint and rethrows others', async () => {
    const dataSource = dataSourceRunning();
    const onUnique = new Map([
      [
        'UQ_vj_clips_preview_storage_key',
        () => vjError('VJ_CLIP_KEY_IN_USE', { field: 'previewStorageKey' }),
      ],
    ]);
    await expect(
      refusalCodeOf(
        runVjTransaction(
          dataSource,
          () =>
            Promise.reject(uniqueViolation('UQ_vj_clips_preview_storage_key')),
          { onUnique },
        ),
      ),
    ).resolves.toBe('VJ_CLIP_KEY_IN_USE');

    const unnamed = uniqueViolation('UQ_vj_clips_storage_key');
    await expect(
      runVjTransaction(dataSource, () => Promise.reject(unnamed), {
        onUnique,
      }),
    ).rejects.toBe(unnamed);

    const plainError = new Error('connection reset');
    await expect(
      runVjTransaction(dataSource, () => Promise.reject(plainError), {
        onUnique,
      }),
    ).rejects.toBe(plainError);

    await expect(
      runVjTransaction(dataSource, () => Promise.resolve('done'), {}),
    ).resolves.toBe('done');

    expect(
      violatedUniqueConstraintOf(uniqueViolation('UQ_vj_clips_storage_key')),
    ).toBe('UQ_vj_clips_storage_key');
    expect(
      violatedUniqueConstraintOf(foreignKeyViolation('FK_vj_scenes_pack')),
    ).toBeNull();
    expect(violatedUniqueConstraintOf(plainError)).toBeNull();
  });

  it('maps a foreign key violation by constraint', async () => {
    const dataSource = dataSourceRunning();
    const onForeignKey = new Map([
      ['FK_vj_setlist_items_scene', () => vjError('VJ_SCENE_NOT_FOUND')],
    ]);
    await expect(
      refusalCodeOf(
        runVjTransaction(
          dataSource,
          () =>
            Promise.reject(foreignKeyViolation('FK_vj_setlist_items_scene')),
          { onForeignKey },
        ),
      ),
    ).resolves.toBe('VJ_SCENE_NOT_FOUND');

    const unnamed = foreignKeyViolation('FK_vj_scenes_pack');
    await expect(
      runVjTransaction(dataSource, () => Promise.reject(unnamed), {
        onForeignKey,
      }),
    ).rejects.toBe(unnamed);

    const uniqueError = uniqueViolation('FK_vj_setlist_items_scene');
    await expect(
      runVjTransaction(dataSource, () => Promise.reject(uniqueError), {
        onForeignKey,
      }),
    ).rejects.toBe(uniqueError);

    expect(
      violatedForeignKeyConstraintOf(
        foreignKeyViolation('FK_vj_setlist_items_scene'),
      ),
    ).toBe('FK_vj_setlist_items_scene');
    expect(
      violatedForeignKeyConstraintOf(
        uniqueViolation('UQ_vj_clips_storage_key'),
      ),
    ).toBeNull();
  });

  it('fills an unset change field with null or an empty list', () => {
    expect(
      buildVjLibraryChange('scene_created', { sceneId: SCENE_ID }),
    ).toEqual({
      kind: 'scene_created',
      packId: null,
      clipId: null,
      packIds: [],
      sceneId: SCENE_ID,
      setlistId: null,
      setlistIds: [],
      eventId: null,
    });

    const setlistIds = [SETLIST_ID];
    const change = buildVjLibraryChange('scene_deleted', {
      sceneId: SCENE_ID,
      setlistIds,
    });
    setlistIds.push(PACK_ID);
    expect(change.setlistIds).toEqual([SETLIST_ID]);
    expect(Object.keys(change)).toEqual([
      'kind',
      'packId',
      'clipId',
      'packIds',
      'sceneId',
      'setlistId',
      'setlistIds',
      'eventId',
    ]);

    expect(
      buildVjLibraryChange('pack_event_changed', {
        packId: PACK_ID,
        eventId: null,
      }),
    ).toMatchObject({
      kind: 'pack_event_changed',
      packId: PACK_ID,
      eventId: null,
    });
  });

  it('logs a failed delete with the key only', async () => {
    const deleteObjectByKey = jest
      .fn()
      .mockRejectedValue(new Error('bucket unavailable'));
    const storage = { deleteObjectByKey } as unknown as StorageService;
    const logger = new Logger('VjLibraryKitSpec');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(
      deleteVjStoredObject(storage, logger, PREVIEW_KEY),
    ).resolves.toBeUndefined();

    expect(deleteObjectByKey).toHaveBeenCalledWith(PREVIEW_KEY);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `VJ object delete failed: ${PREVIEW_KEY}`,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('bucket unavailable');

    deleteObjectByKey.mockClear();
    await deleteVjStoredObject(storage, logger, null);
    expect(deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('lowercases a uuid and refuses anything else with the given code', async () => {
    expect(
      lowercaseIdOrRefuse(SCENE_ID.toUpperCase(), 'VJ_SCENE_NOT_FOUND'),
    ).toBe(SCENE_ID);
    await expect(
      refusalCodeOf(
        Promise.resolve().then(() =>
          lowercaseIdOrRefuse('scene-one', 'VJ_SCENE_NOT_FOUND'),
        ),
      ),
    ).resolves.toBe('VJ_SCENE_NOT_FOUND');
    await expect(
      refusalCodeOf(
        Promise.resolve().then(() =>
          lowercaseIdOrRefuse(42, 'VJ_SETLIST_NOT_FOUND'),
        ),
      ),
    ).resolves.toBe('VJ_SETLIST_NOT_FOUND');
  });

  it('reads driver timestamps as dates', () => {
    const date = new Date('2026-11-06T20:00:00.000Z');
    expect(asVjDate(date)).toBe(date);
    expect(asVjDate('2026-11-06T20:00:00.000Z').getTime()).toBe(date.getTime());
  });

  it('densifies the v2 ordered tables in position and id order', () => {
    expect(DENSIFY_VJ_SCENES_SQL).toContain('UPDATE "vj_scenes"');
    expect(DENSIFY_VJ_SCENES_SQL).toContain('ORDER BY "position", "id"');
    expect(DENSIFY_VJ_SETLISTS_SQL).toContain('UPDATE "vj_setlists"');
    expect(DENSIFY_VJ_SETLISTS_SQL).toContain('ORDER BY "position", "id"');
    expect(DENSIFY_VJ_SETLIST_ITEMS_SQL).toContain('UPDATE "vj_setlist_items"');
    expect(DENSIFY_VJ_SETLIST_ITEMS_SQL).toContain(
      'PARTITION BY "setlist_id" ORDER BY "position", "id"',
    );
    expect(DENSIFY_VJ_SETLIST_ITEMS_SQL).toContain('ANY($1::uuid[])');
    for (const sql of [
      DENSIFY_VJ_SCENES_SQL,
      DENSIFY_VJ_SETLISTS_SQL,
      DENSIFY_VJ_SETLIST_ITEMS_SQL,
    ]) {
      expect(sql).not.toContain('updated_at');
      expect(sql).toContain('<> "ranked"."dense_position"');
    }
  });
});
