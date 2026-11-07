import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import type { CreateVjSceneDto } from './dto/vj.dto';
import { VjScene } from './entities/vj-scene.entity';
import {
  DENSIFY_VJ_SCENES_SQL,
  DENSIFY_VJ_SETLIST_ITEMS_SQL,
  type VjCaller,
} from './vj-library-kit';
import {
  LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL,
  LOCK_VJ_SCENES_SQL,
  VJ_CLIPS_FOR_SHARE_SQL,
  VJ_PACK_FOR_SHARE_SQL,
  VJ_SCENE_ITEM_COUNT_SQL,
  VJ_SCENE_ITEM_COUNTS_SQL,
  VJ_SETLISTS_HOLDING_SCENE_SQL,
  VjSceneService,
} from './vj-scene.service';
import { checkVjSceneLook } from './vj-scene-look';
import { LOCK_VJ_SETLISTS_SQL } from './vj-setlist.service';
import {
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
  type VjSceneLook,
} from './vj.contract';

const ADMIN_ID = 'a7200000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-06T12:00:00.000Z');
const SCENE_NAME = 'Rainbow tunnel drop';
const OVERLAY_TEXT = 'Welcome to the dance floor';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 5 scenes, 6 set lists,
 *  7 set list items, 9 rows the fake store creates. */
function uuidAt(family: number, position: number): string {
  return `a7200000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const MISSING_PACK_ID = uuidAt(1, 9);
const CLIP_ID = uuidAt(2, 1);
const MIX_CLIP_ID = uuidAt(2, 2);
const MISSING_CLIP_ID = uuidAt(2, 8);
const OTHER_MISSING_CLIP_ID = uuidAt(2, 9);
const SCENE_ID = uuidAt(5, 1);
const OTHER_SCENE_ID = uuidAt(5, 2);
const THIRD_SCENE_ID = uuidAt(5, 3);
const SETLIST_ID = uuidAt(6, 1);
const OTHER_SETLIST_ID = uuidAt(6, 2);
const CREATED_ID = uuidAt(9, 1);

const ADMIN: VjCaller = { userId: ADMIN_ID };

/** A valid look as a remote would send it. */
function lookBody(
  sourceClipId: string | null = CLIP_ID,
  mixClipId: string | null = MIX_CLIP_ID,
): Record<string, unknown> {
  return {
    source:
      sourceClipId === null ? null : { kind: 'clip', clipId: sourceClipId },
    effects: {
      speed: 1,
      settings: { glitch: { isOn: true, amount: 0.4, variant: null } },
    },
    transition: { mode: 'fade', length: { unit: 'ms', value: 800 } },
    overlay: {
      text: OVERLAY_TEXT,
      style: 'big',
      isVisible: true,
      position: 'center',
      size: 'l',
      colorToken: 'cream',
    },
    mix: {
      clipId: mixClipId,
      amount: mixClipId === null ? 0 : 0.5,
      blendMode: 'screen',
    },
  };
}

/** A look body with nothing on: a null source, an empty effect list and a hidden overlay. */
function plainLookBody(): Record<string, unknown> {
  return {
    source: null,
    effects: { speed: 2, settings: {} },
    transition: { mode: 'cut', length: { unit: 'beats', value: 4 } },
    overlay: {
      text: '',
      style: 'neon',
      isVisible: false,
      position: 'top',
      size: 's',
      colorToken: 'jade',
    },
    mix: { clipId: null, amount: 0, blendMode: 'normal' },
  };
}

/** The canonical form of a look body, as the service stores it. */
function canonicalLookOf(body: Record<string, unknown>): VjSceneLook {
  const result = checkVjSceneLook(body);
  if (!result.isValid) {
    throw new Error(`fixture look fails at ${result.lookField}`);
  }
  return result.look;
}

function buildScene(overrides: Partial<VjScene> = {}): VjScene {
  return {
    id: SCENE_ID,
    name: SCENE_NAME,
    packId: PACK_ID,
    position: 0,
    look: canonicalLookOf(lookBody()),
    createdByUserId: ADMIN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as VjScene;
}

interface RefusalOutcome {
  code?: string;
  status?: number;
  body?: Record<string, unknown>;
}

async function refusalOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    if (!(error instanceof HttpException)) {
      throw error;
    }
    const body = error.getResponse() as Record<string, unknown>;
    return {
      code: body.code as string | undefined,
      status: error.getStatus(),
      body,
    };
  }
}

interface StoredItem {
  setlistId: string;
  sceneId: string;
}

interface FindOneOptions {
  where: { id: string };
  lock?: { mode: string };
}

describe('VjSceneService', () => {
  let storedScenes: VjScene[];
  let storedClipIds: Set<string>;
  let storedPackIds: Set<string>;
  let storedItems: StoredItem[];
  let recordedSteps: string[];
  let isInTransaction: boolean;
  let transactionCount: number;
  let emittedChanges: { change: VjLibraryChange; isInTransaction: boolean }[];
  let failNextSaveWith: Error | null;
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
  };
  let service: VjSceneService;

  function runQuery(sql: string, parameters: unknown[] = []): unknown[] {
    if (sql === LOCK_VJ_SCENES_SQL) {
      recordedSteps.push('lock scenes');
      return [];
    }
    if (sql === LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL) {
      recordedSteps.push('lock scenes row exclusive');
      return [];
    }
    if (sql === LOCK_VJ_SETLISTS_SQL) {
      recordedSteps.push('lock set lists');
      return [];
    }
    if (sql === VJ_CLIPS_FOR_SHARE_SQL) {
      recordedSteps.push('clips for share');
      return (parameters[0] as string[])
        .filter((clipId) => storedClipIds.has(clipId))
        .map((id) => ({ id }));
    }
    if (sql === VJ_PACK_FOR_SHARE_SQL) {
      recordedSteps.push('pack for share');
      const packId = parameters[0] as string;
      return storedPackIds.has(packId) ? [{ id: packId }] : [];
    }
    if (sql === VJ_SCENE_ITEM_COUNTS_SQL) {
      const sceneIds = parameters[0] as string[];
      return sceneIds
        .map((sceneId) => ({
          scene_id: sceneId,
          item_count: storedItems.filter((item) => item.sceneId === sceneId)
            .length,
        }))
        .filter((row) => row.item_count > 0);
    }
    if (sql === VJ_SETLISTS_HOLDING_SCENE_SQL) {
      recordedSteps.push('set lists for update');
      const sceneId = parameters[0] as string;
      const setlistIds = new Set(
        storedItems
          .filter((item) => item.sceneId === sceneId)
          .map((item) => item.setlistId),
      );
      return [...setlistIds].sort().map((id) => ({ id }));
    }
    if (sql === VJ_SCENE_ITEM_COUNT_SQL) {
      recordedSteps.push('count items');
      const sceneId = parameters[0] as string;
      return [
        {
          item_count: String(
            storedItems.filter((item) => item.sceneId === sceneId).length,
          ),
        },
      ];
    }
    if (sql === DENSIFY_VJ_SCENES_SQL) {
      recordedSteps.push('densify scenes');
      [...storedScenes]
        .sort((left, right) => left.position - right.position)
        .forEach((scene, index) => {
          scene.position = index;
        });
      return [];
    }
    if (sql === DENSIFY_VJ_SETLIST_ITEMS_SQL) {
      recordedSteps.push(
        `densify items ${(parameters[0] as string[]).join(',')}`,
      );
      return [];
    }
    throw new Error('unexpected query');
  }

  beforeEach(() => {
    storedScenes = [];
    storedClipIds = new Set([CLIP_ID, MIX_CLIP_ID]);
    storedPackIds = new Set([PACK_ID]);
    storedItems = [];
    recordedSteps = [];
    isInTransaction = false;
    transactionCount = 0;
    emittedChanges = [];
    failNextSaveWith = null;
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === Profile) {
          return Promise.resolve([
            { userId: ADMIN_ID, firstName: 'Ari', lastName: 'Lopes' },
          ]);
        }
        return Promise.resolve(
          [...storedScenes].sort(
            (left, right) =>
              left.position - right.position || left.id.localeCompare(right.id),
          ),
        );
      }),
      findOne: jest.fn((_entity: unknown, options: FindOneOptions) => {
        recordedSteps.push(
          options.lock ? `scene ${options.lock.mode}` : 'scene read',
        );
        const scene = storedScenes.find(
          (candidate) => candidate.id === options.where.id,
        );
        return Promise.resolve(scene ? { ...scene } : null);
      }),
      count: jest.fn(() => {
        recordedSteps.push('count scenes');
        return Promise.resolve(storedScenes.length);
      }),
      create: jest.fn((_entity: unknown, fields: Partial<VjScene>) => fields),
      save: jest.fn((_entity: unknown, fields: Partial<VjScene>) => {
        recordedSteps.push('insert scene');
        if (failNextSaveWith) {
          return Promise.reject(failNextSaveWith);
        }
        const saved = buildScene({ ...fields, id: CREATED_ID });
        storedScenes.push(saved);
        return Promise.resolve(saved);
      }),
      update: jest.fn(
        (
          _entity: unknown,
          criteria: { id: string },
          patch: Partial<VjScene>,
        ) => {
          recordedSteps.push('update scene');
          const scene = storedScenes.find(
            (candidate) => candidate.id === criteria.id,
          );
          if (scene) {
            Object.assign(scene, patch);
          }
          return Promise.resolve({ affected: scene ? 1 : 0 });
        },
      ),
      delete: jest.fn((_entity: unknown, criteria: { id: string }) => {
        recordedSteps.push('delete scene');
        storedScenes = storedScenes.filter((scene) => scene.id !== criteria.id);
        storedItems = storedItems.filter(
          (item) => item.sceneId !== criteria.id,
        );
        return Promise.resolve({ affected: 1 });
      }),
      query: jest.fn((sql: string, parameters?: unknown[]) =>
        Promise.resolve(runQuery(sql, parameters)),
      ),
    };
    const dataSource = {
      manager,
      transaction: jest.fn(
        async (
          work: (transactionManager: typeof manager) => Promise<unknown>,
        ) => {
          transactionCount += 1;
          isInTransaction = true;
          try {
            return await work(manager);
          } finally {
            isInTransaction = false;
          }
        },
      ),
    } as unknown as DataSource;
    const eventEmitter = {
      emit: jest.fn((eventName: string, change: VjLibraryChange) => {
        expect(eventName).toBe(VJ_LIBRARY_CHANGED);
        emittedChanges.push({ change, isInTransaction });
        return true;
      }),
    } as unknown as EventEmitter2;
    service = new VjSceneService(dataSource, eventEmitter);
  });

  function createBody(fields: Record<string, unknown> = {}): CreateVjSceneDto {
    return {
      name: SCENE_NAME,
      packId: PACK_ID,
      look: lookBody(),
      ...fields,
    };
  }

  function fillScenes(count: number): void {
    for (let index = 0; index < count; index += 1) {
      storedScenes.push(
        buildScene({ id: uuidAt(8, index + 1), position: index }),
      );
    }
  }

  it('checks a scene create in the contract order', async () => {
    const badEverything = {
      name: '   ',
      packId: 'x',
      look: { source: null },
    };
    expect(
      (await refusalOf(service.createScene(ADMIN, createBody(badEverything))))
        .code,
    ).toBe('VJ_SCENE_NAME_REQUIRED');
    expect(
      (
        await refusalOf(
          service.createScene(
            ADMIN,
            createBody({
              name: 'a'.repeat(VJ_LIMITS.sceneNameMax + 1),
              packId: 'x',
            }),
          ),
        )
      ).code,
    ).toBe('VJ_SCENE_NAME_TOO_LONG');
    expect(
      (
        await refusalOf(
          service.createScene(
            ADMIN,
            createBody({ packId: 'x', look: { source: null } }),
          ),
        )
      ).code,
    ).toBe('VJ_PACK_NOT_FOUND');
    const lookRefusal = await refusalOf(
      service.createScene(
        ADMIN,
        createBody({
          packId: MISSING_PACK_ID,
          look: {
            ...lookBody(),
            mix: { clipId: null, amount: -1, blendMode: 'normal' },
          },
        }),
      ),
    );
    expect(lookRefusal.code).toBe('VJ_SCENE_LOOK_INVALID');
    expect(lookRefusal.status).toBe(400);
    expect(lookRefusal.body?.lookField).toBe('mix.amount');
    expect(transactionCount).toBe(0);

    fillScenes(VJ_LIMITS.scenesMax);
    expect(
      (
        await refusalOf(
          service.createScene(
            ADMIN,
            createBody({
              packId: MISSING_PACK_ID,
              look: lookBody(MISSING_CLIP_ID),
            }),
          ),
        )
      ).code,
    ).toBe('VJ_PACK_NOT_FOUND');
    expect(
      (
        await refusalOf(
          service.createScene(
            ADMIN,
            createBody({ look: lookBody(MISSING_CLIP_ID) }),
          ),
        )
      ).code,
    ).toBe('VJ_SCENE_CLIP_NOT_FOUND');
    expect(
      (await refusalOf(service.createScene(ADMIN, createBody()))).code,
    ).toBe('VJ_SCENE_LIMIT_REACHED');
    expect(manager.save).not.toHaveBeenCalled();
    expect(emittedChanges).toHaveLength(0);
  });

  it('reads named clips for share before the scene row', async () => {
    await service.createScene(ADMIN, createBody());
    expect(recordedSteps.slice(0, 5)).toEqual([
      'clips for share',
      'pack for share',
      'lock scenes',
      'count scenes',
      'insert scene',
    ]);
    expect(manager.query).toHaveBeenCalledWith(VJ_CLIPS_FOR_SHARE_SQL, [
      [CLIP_ID, MIX_CLIP_ID],
    ]);

    storedScenes = [buildScene()];
    recordedSteps = [];
    await service.updateScene(SCENE_ID, {
      packId: PACK_ID,
      look: lookBody(MIX_CLIP_ID, CLIP_ID),
    });
    expect(recordedSteps.slice(0, 5)).toEqual([
      'clips for share',
      'pack for share',
      'lock scenes row exclusive',
      'scene pessimistic_write',
      'update scene',
    ]);
  });

  it('takes the table locks before the rows they guard', async () => {
    storedScenes = [buildScene()];
    await service.updateScene(SCENE_ID, { name: 'Late drop' });
    expect(recordedSteps.slice(0, 3)).toEqual([
      'lock scenes row exclusive',
      'scene pessimistic_write',
      'update scene',
    ]);
    expect(recordedSteps).not.toContain('lock scenes');
    expect(LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL).toBe(
      'LOCK TABLE "vj_scenes" IN ROW EXCLUSIVE MODE',
    );

    storedItems = [{ setlistId: SETLIST_ID, sceneId: SCENE_ID }];
    recordedSteps = [];
    await service.deleteScene(SCENE_ID);
    expect(recordedSteps.slice(0, 4)).toEqual([
      'lock scenes',
      'scene pessimistic_write',
      'lock set lists',
      'set lists for update',
    ]);
  });

  it('answers VJ_SCENE_CLIP_NOT_FOUND naming the source before the mix', async () => {
    const bothMissing = await refusalOf(
      service.createScene(
        ADMIN,
        createBody({ look: lookBody(MISSING_CLIP_ID, OTHER_MISSING_CLIP_ID) }),
      ),
    );
    expect(bothMissing.code).toBe('VJ_SCENE_CLIP_NOT_FOUND');
    expect(bothMissing.status).toBe(404);
    expect(bothMissing.body?.lookField).toBe('source.clipId');

    const mixMissing = await refusalOf(
      service.createScene(
        ADMIN,
        createBody({ look: lookBody(CLIP_ID, MISSING_CLIP_ID) }),
      ),
    );
    expect(mixMissing.body?.lookField).toBe('mix.clipId');

    storedScenes = [buildScene()];
    const updateMissing = await refusalOf(
      service.updateScene(SCENE_ID, {
        look: lookBody(null, MISSING_CLIP_ID),
      }),
    );
    expect(updateMissing.code).toBe('VJ_SCENE_CLIP_NOT_FOUND');
    expect(updateMissing.body?.lookField).toBe('mix.clipId');
  });

  it('refuses the 201st scene', async () => {
    fillScenes(VJ_LIMITS.scenesMax);
    const refusal = await refusalOf(service.createScene(ADMIN, createBody()));
    expect(refusal.code).toBe('VJ_SCENE_LIMIT_REACHED');
    expect(refusal.status).toBe(409);

    storedScenes.pop();
    const created = await service.createScene(ADMIN, createBody());
    expect(created.id).toBe(CREATED_ID);
    expect(created.position).toBe(VJ_LIMITS.scenesMax - 1);
    expect(created.createdBy).toEqual({
      userId: ADMIN_ID,
      displayName: 'Ari Lopes',
    });
    expect(manager.create).toHaveBeenCalledWith(VjScene, {
      name: SCENE_NAME,
      packId: PACK_ID,
      position: VJ_LIMITS.scenesMax - 1,
      look: canonicalLookOf(lookBody()),
      createdByUserId: ADMIN_ID,
    });
  });

  it('allows two scenes with one name', async () => {
    storedScenes = [buildScene()];
    const created = await service.createScene(
      ADMIN,
      createBody({ name: `  ${SCENE_NAME}  `, packId: null }),
    );
    expect(created.name).toBe(SCENE_NAME);
    expect(created.packId).toBeNull();
    expect(storedScenes.map((scene) => scene.name)).toEqual([
      SCENE_NAME,
      SCENE_NAME,
    ]);
    expect(recordedSteps).not.toContain('pack for share');
  });

  it('answers the current scene for an empty body and emits nothing', async () => {
    storedScenes = [buildScene()];
    const current = await service.updateScene(SCENE_ID.toUpperCase(), {});
    expect(current.id).toBe(SCENE_ID);
    expect(current.name).toBe(SCENE_NAME);
    expect(transactionCount).toBe(0);

    const unchanged = await service.updateScene(SCENE_ID, {
      name: SCENE_NAME,
      packId: PACK_ID,
      look: lookBody(),
    });
    expect(unchanged.name).toBe(SCENE_NAME);
    expect(manager.update).not.toHaveBeenCalled();
    expect(emittedChanges).toHaveLength(0);

    expect((await refusalOf(service.updateScene('x', {}))).code).toBe(
      'VJ_SCENE_NOT_FOUND',
    );
    expect(
      (await refusalOf(service.updateScene(OTHER_SCENE_ID, {}))).code,
    ).toBe('VJ_SCENE_NOT_FOUND');
  });

  it('checks a scene update in the contract order', async () => {
    storedScenes = [buildScene()];
    expect((await refusalOf(service.updateScene('x', { name: '' }))).code).toBe(
      'VJ_SCENE_NOT_FOUND',
    );
    expect(
      (
        await refusalOf(
          service.updateScene(SCENE_ID, {
            name: '',
            packId: 'x',
          }),
        )
      ).code,
    ).toBe('VJ_SCENE_NAME_REQUIRED');
    expect(
      (
        await refusalOf(
          service.updateScene(SCENE_ID, {
            packId: 'x',
            look: 'look',
          }),
        )
      ).code,
    ).toBe('VJ_PACK_NOT_FOUND');
    expect(
      (await refusalOf(service.updateScene(SCENE_ID, { look: 'look' }))).body
        ?.lookField,
    ).toBe('');
    expect(transactionCount).toBe(0);
    expect(
      (
        await refusalOf(
          service.updateScene(OTHER_SCENE_ID, {
            packId: MISSING_PACK_ID,
          }),
        )
      ).code,
    ).toBe('VJ_SCENE_NOT_FOUND');
    expect(
      (
        await refusalOf(
          service.updateScene(SCENE_ID, {
            packId: MISSING_PACK_ID,
            look: lookBody(MISSING_CLIP_ID),
          }),
        )
      ).code,
    ).toBe('VJ_PACK_NOT_FOUND');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('replaces the look whole on update', async () => {
    storedScenes = [buildScene()];
    const updated = await service.updateScene(SCENE_ID, {
      look: plainLookBody(),
    });
    const expectedLook = canonicalLookOf(plainLookBody());
    expect(manager.update).toHaveBeenCalledWith(
      VjScene,
      { id: SCENE_ID },
      { look: expectedLook },
    );
    expect(updated.look).toEqual(expectedLook);
    expect(updated.look.effects.settings).toEqual({});
    expect(updated.name).toBe(SCENE_NAME);
    expect(updated.packId).toBe(PACK_ID);
    expect(recordedSteps).not.toContain('clips for share');
    expect(emittedChanges.map((entry) => entry.change.kind)).toEqual([
      'scene_updated',
    ]);
  });

  it('reorders with the full list only', async () => {
    storedScenes = [
      buildScene({ id: SCENE_ID, position: 0 }),
      buildScene({ id: OTHER_SCENE_ID, position: 1 }),
      buildScene({ id: THIRD_SCENE_ID, position: 2 }),
    ];
    const partial = await refusalOf(
      service.reorderScenes({ sceneIds: [THIRD_SCENE_ID, SCENE_ID] }),
    );
    expect(partial.code).toBe('VJ_SCENE_REORDER_MISMATCH');
    const repeated = await refusalOf(
      service.reorderScenes({
        sceneIds: [THIRD_SCENE_ID, SCENE_ID, SCENE_ID],
      }),
    );
    expect(repeated.code).toBe('VJ_SCENE_REORDER_MISMATCH');
    expect(manager.update).not.toHaveBeenCalled();

    recordedSteps = [];
    const list = await service.reorderScenes({
      sceneIds: [THIRD_SCENE_ID, SCENE_ID, OTHER_SCENE_ID.toUpperCase()],
    });
    expect(recordedSteps[0]).toBe('lock scenes');
    expect(list.items.map((scene) => [scene.id, scene.position])).toEqual([
      [THIRD_SCENE_ID, 0],
      [SCENE_ID, 1],
      [OTHER_SCENE_ID, 2],
    ]);
    expect(emittedChanges.map((entry) => entry.change.kind)).toEqual([
      'scenes_reordered',
    ]);

    await service.reorderScenes({
      sceneIds: [THIRD_SCENE_ID, SCENE_ID, OTHER_SCENE_ID],
    });
    expect(emittedChanges).toHaveLength(1);
  });

  it('deletes a scene, counts its set list items and densifies both tables', async () => {
    storedScenes = [
      buildScene({ id: SCENE_ID, position: 0 }),
      buildScene({ id: OTHER_SCENE_ID, position: 1 }),
      buildScene({ id: THIRD_SCENE_ID, position: 2 }),
    ];
    storedItems = [
      { setlistId: OTHER_SETLIST_ID, sceneId: OTHER_SCENE_ID },
      { setlistId: SETLIST_ID, sceneId: OTHER_SCENE_ID },
      { setlistId: OTHER_SETLIST_ID, sceneId: OTHER_SCENE_ID },
      { setlistId: SETLIST_ID, sceneId: THIRD_SCENE_ID },
    ];
    const deleted = await service.deleteScene(OTHER_SCENE_ID.toUpperCase());
    expect(deleted).toEqual({
      deletedSceneId: OTHER_SCENE_ID,
      removedFromSetlistCount: 3,
    });
    expect(recordedSteps).toEqual([
      'lock scenes',
      'scene pessimistic_write',
      'lock set lists',
      'set lists for update',
      'count items',
      'delete scene',
      'densify scenes',
      `densify items ${SETLIST_ID},${OTHER_SETLIST_ID}`,
    ]);
    expect(storedScenes.map((scene) => [scene.id, scene.position])).toEqual([
      [SCENE_ID, 0],
      [THIRD_SCENE_ID, 1],
    ]);
    expect(emittedChanges[0]?.change).toEqual({
      kind: 'scene_deleted',
      packId: null,
      clipId: null,
      packIds: [],
      sceneId: OTHER_SCENE_ID,
      setlistId: null,
      setlistIds: [SETLIST_ID, OTHER_SETLIST_ID],
      eventId: null,
    });

    recordedSteps = [];
    const unheld = await service.deleteScene(SCENE_ID);
    expect(unheld.removedFromSetlistCount).toBe(0);
    expect(recordedSteps.some((step) => step.startsWith('densify items'))).toBe(
      false,
    );

    expect((await refusalOf(service.deleteScene('x'))).code).toBe(
      'VJ_SCENE_NOT_FOUND',
    );
    expect((await refusalOf(service.deleteScene(SCENE_ID))).code).toBe(
      'VJ_SCENE_NOT_FOUND',
    );
  });

  it('lists scenes in order with normalised looks and item counts', async () => {
    const storedLook = {
      ...canonicalLookOf(lookBody()),
      effects: {
        speed: 1,
        settings: {
          glitch: { isOn: true, amount: 0.4, variant: null },
          retiredEffect: { isOn: true, amount: 1, variant: null },
        },
      },
    } as unknown as VjSceneLook;
    storedScenes = [
      buildScene({ id: OTHER_SCENE_ID, position: 1, createdByUserId: null }),
      buildScene({ id: SCENE_ID, position: 0, look: storedLook }),
    ];
    storedItems = [
      { setlistId: SETLIST_ID, sceneId: SCENE_ID },
      { setlistId: OTHER_SETLIST_ID, sceneId: SCENE_ID },
    ];
    const list = await service.listScenes();
    expect(list.items.map((scene) => scene.id)).toEqual([
      SCENE_ID,
      OTHER_SCENE_ID,
    ]);
    expect(list.items[0]?.setlistItemCount).toBe(2);
    expect(list.items[1]?.setlistItemCount).toBe(0);
    expect(list.items[1]?.createdBy).toBeNull();
    expect(Object.keys(list.items[0]?.look.effects.settings ?? {})).toEqual([
      'glitch',
    ]);
    expect(list.items[0]?.createdAt).toBe(NOW.toISOString());
  });

  it('maps a pack deleted mid-write to VJ_PACK_NOT_FOUND', async () => {
    failNextSaveWith = new QueryFailedError(
      'INSERT',
      [],
      Object.assign(new Error('foreign key violation'), {
        code: '23503',
        constraint: 'FK_vj_scenes_pack',
      }),
    );
    expect(
      (await refusalOf(service.createScene(ADMIN, createBody()))).code,
    ).toBe('VJ_PACK_NOT_FOUND');
    expect(emittedChanges).toHaveLength(0);
  });

  it('emits one change per write after commit', async () => {
    const created = await service.createScene(ADMIN, createBody());
    await service.updateScene(created.id, {
      name: 'Second take',
    });
    await service.deleteScene(created.id);
    expect(emittedChanges.map((entry) => entry.change.kind)).toEqual([
      'scene_created',
      'scene_updated',
      'scene_deleted',
    ]);
    expect(emittedChanges.every((entry) => !entry.isInTransaction)).toBe(true);
    expect(emittedChanges[0]?.change).toEqual({
      kind: 'scene_created',
      packId: null,
      clipId: null,
      packIds: [],
      sceneId: CREATED_ID,
      setlistId: null,
      setlistIds: [],
      eventId: null,
    });
    expect(emittedChanges[1]?.change.sceneId).toBe(CREATED_ID);
  });

  it('keeps refusal messages free of names and looks', async () => {
    const longName = `${SCENE_NAME} ${'z'.repeat(VJ_LIMITS.sceneNameMax)}`;
    const outcomes = [
      await refusalOf(
        service.createScene(ADMIN, createBody({ name: longName })),
      ),
      await refusalOf(
        service.createScene(
          ADMIN,
          createBody({
            look: {
              ...lookBody(),
              overlay: {
                ...(lookBody().overlay as object),
                style: OVERLAY_TEXT,
              },
            },
          }),
        ),
      ),
      await refusalOf(
        service.createScene(
          ADMIN,
          createBody({ look: lookBody(MISSING_CLIP_ID) }),
        ),
      ),
    ];
    expect(outcomes.map((outcome) => outcome.code)).toEqual([
      'VJ_SCENE_NAME_TOO_LONG',
      'VJ_SCENE_LOOK_INVALID',
      'VJ_SCENE_CLIP_NOT_FOUND',
    ]);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome.body);
      expect(serialized).not.toContain(SCENE_NAME);
      expect(serialized).not.toContain(OVERLAY_TEXT);
      expect(serialized).not.toContain(MISSING_CLIP_ID);
    }
    expect(outcomes[1]?.body?.lookField).toBe('overlay.style');
  });
});
