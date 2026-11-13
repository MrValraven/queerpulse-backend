import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { VjSetlistItem } from './entities/vj-setlist-item.entity';
import { VjSetlist } from './entities/vj-setlist.entity';
import { DENSIFY_VJ_SETLISTS_SQL, type VjCaller } from './vj-library-kit';
import { VJ_SCENES_NAMING_CLIP_SQL } from './vj-library.service';
import {
  LOCK_VJ_SETLISTS_SQL,
  TOUCH_VJ_SETLIST_SQL,
  VJ_CLIPS_FOR_SHARE_SQL,
  VJ_SCENES_FOR_SHARE_SQL,
  VJ_SETLIST_NAME_HOLDER_SQL,
  VjSetlistService,
} from './vj-setlist.service';
import {
  DEFAULT_VJ_STEP_DURATION,
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
} from './vj.contract';

const ADMIN_ID = 'a7100000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-06T12:00:00.000Z');
const LATER = new Date('2026-11-06T12:05:00.000Z');

/** A v4 uuid in a numbered family: 4 clips, 5 scenes, 6 set lists, 7 items,
 *  9 rows the fake store creates. */
function uuidAt(family: number, position: number): string {
  return `a7100000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const SCENE_ID = uuidAt(5, 1);
const OTHER_SCENE_ID = uuidAt(5, 2);
const UNKNOWN_SCENE_ID = uuidAt(5, 99);
const CLIP_ID = uuidAt(4, 1);
const OTHER_CLIP_ID = uuidAt(4, 2);
const UNKNOWN_CLIP_ID = uuidAt(4, 99);
const UNKNOWN_ITEM_ID = uuidAt(7, 999);
const SETLIST_ID = uuidAt(6, 1);
const OTHER_SETLIST_ID = uuidAt(6, 2);
const UNKNOWN_SETLIST_ID = uuidAt(6, 99);
const CREATED_ID = uuidAt(9, 1);

const ADMIN: VjCaller = { userId: ADMIN_ID };

interface RefusalOutcome {
  code?: string;
  status?: number;
  body?: Record<string, unknown>;
}

async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
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

function buildSetlist(overrides: Partial<VjSetlist> = {}): VjSetlist {
  return {
    id: SETLIST_ID,
    name: 'Friday set',
    position: 0,
    isLooping: false,
    stepDurationKind: 'seconds',
    stepDurationValue: 8,
    createdByUserId: ADMIN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as VjSetlist;
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

/** A scene step of a whole-list body. */
function sceneStep(
  sceneId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: 'scene', sceneId, ...extra };
}

/** A clip step of a whole-list body. */
function clipStep(
  clipId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: 'clip', clipId, ...extra };
}

/** Every library change field, unset ones null or empty. */
function fullChange(
  fields: Partial<VjLibraryChange> & Pick<VjLibraryChange, 'kind'>,
): VjLibraryChange {
  return {
    packId: null,
    clipId: null,
    packIds: [],
    sceneId: null,
    setlistId: null,
    setlistIds: [],
    eventId: null,
    ...fields,
  };
}

type Row = Record<string, unknown>;
type Criteria = Record<string, unknown>;
interface FindOptions {
  where?: Criteria;
  lock?: { mode: string };
}

describe('VjSetlistService', () => {
  let storedSetlists: VjSetlist[];
  let storedItems: VjSetlistItem[];
  let storedSceneIds: string[];
  let storedClipIds: string[];
  let storedProfiles: Profile[];
  let nextItemNumber: number;
  let operations: string[];
  let settledTransactions: number;
  let settledAtEmit: number[];
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    insert: jest.Mock;
    query: jest.Mock;
  };
  let dataSource: { manager: typeof manager; transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let service: VjSetlistService;

  function rowsOf(entity: unknown): Row[] {
    if (entity === VjSetlist) return storedSetlists as unknown as Row[];
    if (entity === VjSetlistItem) return storedItems as unknown as Row[];
    if (entity === Profile) return storedProfiles as unknown as Row[];
    throw new Error('Unexpected entity');
  }

  function entityName(entity: unknown): string {
    return (entity as { name: string }).name;
  }

  function matches(row: Row, criteria: Criteria | undefined): boolean {
    return Object.entries(criteria ?? {}).every(([field, expected]) =>
      expected instanceof FindOperator
        ? (expected.value as unknown[]).includes(row[field])
        : row[field] === expected,
    );
  }

  function findRows(entity: unknown, options?: FindOptions): Row[] {
    const rows = rowsOf(entity).filter((row) => matches(row, options?.where));
    if (entity === VjSetlist || entity === VjSetlistItem) {
      return [...rows].sort(
        (first, second) =>
          Number(first.position) - Number(second.position) ||
          String(first.id).localeCompare(String(second.id)),
      );
    }
    return rows;
  }

  function removeRows(entity: unknown, criteria: Criteria): void {
    const rows = rowsOf(entity);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row && matches(row, criteria)) {
        rows.splice(index, 1);
      }
    }
  }

  function runQuery(sql: string, parameters: unknown[] = []): unknown[] {
    if (sql === LOCK_VJ_SETLISTS_SQL) {
      return [];
    }
    if (sql === VJ_SCENES_FOR_SHARE_SQL) {
      const sceneIds = parameters[0] as string[];
      return storedSceneIds
        .filter((sceneId) => sceneIds.includes(sceneId))
        .map((sceneId) => ({ id: sceneId }));
    }
    if (sql === VJ_CLIPS_FOR_SHARE_SQL) {
      const clipIds = parameters[0] as string[];
      return storedClipIds
        .filter((clipId) => clipIds.includes(clipId))
        .map((clipId) => ({ id: clipId }));
    }
    if (sql === VJ_SETLIST_NAME_HOLDER_SQL) {
      const [name, exceptId] = parameters as [string, string | null];
      return storedSetlists
        .filter(
          (setlist) =>
            setlist.name.toLowerCase() === name.toLowerCase() &&
            setlist.id !== exceptId,
        )
        .map((setlist) => ({ id: setlist.id }));
    }
    if (sql === DENSIFY_VJ_SETLISTS_SQL) {
      findRows(VjSetlist).forEach((row, position) => {
        row.position = position;
      });
      return [];
    }
    if (sql === TOUCH_VJ_SETLIST_SQL) {
      for (const setlist of storedSetlists) {
        if (setlist.id === parameters[0]) setlist.updatedAt = LATER;
      }
      return [];
    }
    throw new Error('Unexpected SQL');
  }

  /** The SQL text of every `manager.query` call, in order. */
  function queriedSql(): string[] {
    return manager.query.mock.calls.map((call: unknown[]) => call[0] as string);
  }

  /** The emitted library changes, in order. */
  function emittedChanges(): VjLibraryChange[] {
    return eventEmitter.emit.mock.calls.map(
      (call: unknown[]) => call[1] as VjLibraryChange,
    );
  }

  beforeEach(() => {
    storedSetlists = [];
    storedItems = [];
    storedSceneIds = [SCENE_ID, OTHER_SCENE_ID];
    storedClipIds = [CLIP_ID, OTHER_CLIP_ID];
    storedProfiles = [
      { userId: ADMIN_ID, firstName: 'Rui', lastName: 'Lopes' } as Profile,
    ];
    nextItemNumber = 1;
    operations = [];
    settledTransactions = 0;
    settledAtEmit = [];
    manager = {
      find: jest.fn((entity: unknown, options?: FindOptions) =>
        Promise.resolve(findRows(entity, options)),
      ),
      findOne: jest.fn((entity: unknown, options?: FindOptions) => {
        const lockMode = options?.lock?.mode;
        operations.push(
          `findOne:${entityName(entity)}${lockMode ? `:${lockMode}` : ''}`,
        );
        return Promise.resolve(findRows(entity, options)[0] ?? null);
      }),
      count: jest.fn((entity: unknown, options?: FindOptions) =>
        Promise.resolve(findRows(entity, options).length),
      ),
      create: jest.fn((_entity: unknown, data: Row) => ({ ...data })),
      save: jest.fn((entity: unknown, row: Row) => {
        operations.push(`save:${entityName(entity)}`);
        const saved: Row = {
          id: CREATED_ID,
          createdAt: NOW,
          updatedAt: NOW,
          ...row,
        };
        rowsOf(entity).push(saved);
        return Promise.resolve(saved);
      }),
      update: jest.fn((entity: unknown, criteria: Criteria, values: Row) => {
        operations.push(`update:${entityName(entity)}`);
        for (const row of rowsOf(entity).filter((candidate) =>
          matches(candidate, criteria),
        )) {
          Object.assign(row, values);
        }
        return Promise.resolve({ affected: 1 });
      }),
      delete: jest.fn((entity: unknown, criteria: Criteria) => {
        operations.push(`delete:${entityName(entity)}`);
        removeRows(entity, criteria);
        if (entity === VjSetlist) {
          removeRows(VjSetlistItem, { setlistId: criteria.id });
        }
        return Promise.resolve({ affected: 1 });
      }),
      insert: jest.fn((entity: unknown, rows: Row[]) => {
        operations.push(`insert:${entityName(entity)}`);
        for (const row of rows) {
          rowsOf(entity).push({ id: uuidAt(7, nextItemNumber), ...row });
          nextItemNumber += 1;
        }
        return Promise.resolve({ identifiers: [] });
      }),
      query: jest.fn((sql: string, parameters?: unknown[]) => {
        operations.push(`query:${sql}`);
        return Promise.resolve(runQuery(sql, parameters));
      }),
    };
    dataSource = {
      manager,
      transaction: jest.fn(
        async (work: (transactionManager: typeof manager) => unknown) => {
          const result = await work(manager);
          settledTransactions += 1;
          return result;
        },
      ),
    };
    eventEmitter = {
      emit: jest.fn(() => {
        settledAtEmit.push(settledTransactions);
        return true;
      }),
    };
    service = new VjSetlistService(
      dataSource as unknown as DataSource,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Seeds `count` set lists at positions `0..count-1`. */
  function seedSetlists(count: number): void {
    for (let position = 0; position < count; position += 1) {
      storedSetlists.push(
        buildSetlist({
          id: uuidAt(6, position + 1),
          name: `Set ${position}`,
          position,
        }),
      );
    }
  }

  /** Seeds one scene step of a set list and answers its id. */
  function seedItem(
    setlistId: string,
    sceneId: string,
    position: number,
  ): string {
    const id = uuidAt(7, 500 + storedItems.length);
    storedItems.push({
      id,
      setlistId,
      kind: 'scene',
      sceneId,
      clipId: null,
      durationKind: null,
      durationValue: null,
      position,
    } as VjSetlistItem);
    return id;
  }

  /** Seeds one clip step of a set list and answers its id. */
  function seedClipItem(
    setlistId: string,
    clipId: string,
    position: number,
    duration: { kind: 'seconds' | 'beats'; value: number } | null = null,
  ): string {
    const id = uuidAt(7, 500 + storedItems.length);
    storedItems.push({
      id,
      setlistId,
      kind: 'clip',
      sceneId: null,
      clipId,
      durationKind: duration?.kind ?? null,
      durationValue: duration?.value ?? null,
      position,
    } as VjSetlistItem);
    return id;
  }

  /** The stored steps of a set list in position order, as `[id, kind,
   *  target, position]`. */
  function storedStepsOf(setlistId: string): unknown[][] {
    return findRows(VjSetlistItem, { where: { setlistId } }).map((row) => [
      row.id,
      row.kind,
      row.kind === 'scene' ? row.sceneId : row.clipId,
      row.position,
    ]);
  }

  it('checks a set list create in the contract order', async () => {
    expect(await codeOf(service.createSetlist(ADMIN, { name: '   ' }))).toEqual(
      expect.objectContaining({
        code: 'VJ_SETLIST_NAME_REQUIRED',
        status: 400,
      }),
    );
    expect(
      (
        await codeOf(
          service.createSetlist(ADMIN, { name: 'x'.repeat(61), sceneIds: 'x' }),
        )
      ).code,
    ).toBe('VJ_SETLIST_NAME_TOO_LONG');
    expect(
      (
        await codeOf(
          service.createSetlist(ADMIN, { name: 'Late', sceneIds: ['nope'] }),
        )
      ).code,
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
    expect(
      (
        await codeOf(
          service.createSetlist(ADMIN, { name: 'Late', sceneIds: null }),
        )
      ).code,
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
    const full = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Late',
        sceneIds: Array.from(
          { length: VJ_LIMITS.setlistItemsMax + 1 },
          () => SCENE_ID,
        ),
      }),
    );
    expect(full).toEqual(
      expect.objectContaining({ code: 'VJ_SETLIST_FULL', status: 409 }),
    );
    expect(full.body?.setlistId).toBeUndefined();
    expect(dataSource.transaction).not.toHaveBeenCalled();

    seedSetlists(VJ_LIMITS.setlistsMax);
    expect(
      (
        await codeOf(
          service.createSetlist(ADMIN, {
            name: 'Set 0',
            sceneIds: [UNKNOWN_SCENE_ID],
          }),
        )
      ).code,
    ).toBe('VJ_SETLIST_LIMIT_REACHED');

    storedSetlists = [];
    seedSetlists(3);
    const holder = storedSetlists[1] as VjSetlist;
    const taken = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Set 1',
        sceneIds: [UNKNOWN_SCENE_ID],
      }),
    );
    expect(taken).toEqual(
      expect.objectContaining({ code: 'VJ_SETLIST_NAME_TAKEN', status: 409 }),
    );
    expect(taken.body?.setlistId).toBe(holder.id);

    const unknownScene = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Late',
        sceneIds: [SCENE_ID, UNKNOWN_SCENE_ID, uuidAt(5, 98)],
      }),
    );
    expect(unknownScene).toEqual(
      expect.objectContaining({ code: 'VJ_SCENE_NOT_FOUND', status: 404 }),
    );
    expect(unknownScene.body?.sceneId).toBe(UNKNOWN_SCENE_ID);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    manager.query.mockClear();
    const created = await service.createSetlist(ADMIN, { name: '  Late  ' });
    expect(created).toMatchObject({
      id: CREATED_ID,
      name: 'Late',
      position: 3,
      isLooping: false,
      stepDuration: DEFAULT_VJ_STEP_DURATION,
      items: [],
      createdBy: { userId: ADMIN_ID, displayName: 'Rui Lopes' },
    });
    expect(queriedSql()).not.toContain(VJ_SCENES_FOR_SHARE_SQL);
    expect(queriedSql()).not.toContain(VJ_CLIPS_FOR_SHARE_SQL);
  });

  it('checks the sequences fields of a create in the contract order', async () => {
    const createCode = async (body: Record<string, unknown>) =>
      (await codeOf(service.createSetlist(ADMIN, { name: 'Late', ...body })))
        .code;

    expect(
      await createCode({ sceneIds: [SCENE_ID], items: [sceneStep(SCENE_ID)] }),
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
    expect(await createCode({ items: 'steps' })).toBe(
      'VJ_SETLIST_ITEMS_INVALID',
    );
    expect(await createCode({ items: [{ kind: 'look' }] })).toBe(
      'VJ_SETLIST_STEP_INVALID',
    );
    expect(
      await createCode({
        items: [sceneStep(SCENE_ID, { duration: { kind: 'beats', value: 3 } })],
      }),
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    expect(
      await createCode({ items: [{ kind: 'look' }], isLooping: 'yes' }),
    ).toBe('VJ_SETLIST_STEP_INVALID');
    expect(await createCode({ isLooping: 'yes' })).toBe(
      'VJ_SETLIST_LOOP_INVALID',
    );
    expect(
      await createCode({
        isLooping: 'yes',
        stepDuration: { kind: 'seconds', value: 1 },
      }),
    ).toBe('VJ_SETLIST_LOOP_INVALID');
    expect(
      await createCode({ stepDuration: { kind: 'seconds', value: 1 } }),
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    expect(
      await createCode({
        items: [sceneStep(SCENE_ID, { id: uuidAt(7, 1) })],
        stepDuration: { kind: 'seconds', value: 1 },
      }),
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    const withId = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Late',
        items: [sceneStep(SCENE_ID, { id: uuidAt(7, 1) })],
      }),
    );
    expect(withId).toEqual(
      expect.objectContaining({
        code: 'VJ_SETLIST_ITEM_NOT_FOUND',
        status: 404,
      }),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();

    const scenesFirst = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Late',
        items: [
          clipStep(CLIP_ID),
          clipStep(UNKNOWN_CLIP_ID),
          sceneStep(UNKNOWN_SCENE_ID),
        ],
      }),
    );
    expect(scenesFirst.code).toBe('VJ_SCENE_NOT_FOUND');
    expect(scenesFirst.body?.sceneId).toBe(UNKNOWN_SCENE_ID);
    const missingClip = await codeOf(
      service.createSetlist(ADMIN, {
        name: 'Late',
        items: [clipStep(CLIP_ID), clipStep(UNKNOWN_CLIP_ID)],
      }),
    );
    expect(missingClip).toEqual(
      expect.objectContaining({ code: 'VJ_CLIP_NOT_FOUND', status: 404 }),
    );
    expect(missingClip.body?.clipId).toBe(UNKNOWN_CLIP_ID);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('creates a sequence of scene and clip steps with its Loop and length', async () => {
    const created = await service.createSetlist(ADMIN, {
      name: 'Friday set',
      items: [
        clipStep(CLIP_ID.toUpperCase(), {
          duration: { kind: 'beats', value: 16 },
        }),
        sceneStep(SCENE_ID),
        clipStep(CLIP_ID, { duration: null }),
      ],
      isLooping: true,
      stepDuration: { kind: 'beats', value: 32 },
    });

    expect(created).toMatchObject({
      isLooping: true,
      stepDuration: { kind: 'beats', value: 32 },
    });
    expect(
      created.items.map((item) => [
        item.kind,
        item.sceneId,
        item.clipId,
        item.duration,
        item.position,
      ]),
    ).toEqual([
      ['clip', null, CLIP_ID, { kind: 'beats', value: 16 }, 0],
      ['scene', SCENE_ID, null, null, 1],
      ['clip', null, CLIP_ID, null, 2],
    ]);
    expect(manager.create).toHaveBeenCalledWith(
      VjSetlist,
      expect.objectContaining({
        isLooping: true,
        stepDurationKind: 'beats',
        stepDurationValue: 32,
      }),
    );
    expect(operations.slice(0, 3)).toEqual([
      `query:${VJ_SCENES_FOR_SHARE_SQL}`,
      `query:${VJ_CLIPS_FOR_SHARE_SQL}`,
      `query:${LOCK_VJ_SETLISTS_SQL}`,
    ]);
    expect(manager.query).toHaveBeenCalledWith(VJ_CLIPS_FOR_SHARE_SQL, [
      [CLIP_ID],
    ]);
  });

  it('checks a set list items put in the contract order', async () => {
    storedSetlists.push(buildSetlist());
    storedSetlists.push(
      buildSetlist({ id: OTHER_SETLIST_ID, name: 'Closing', position: 1 }),
    );
    const foreignItemId = seedItem(OTHER_SETLIST_ID, SCENE_ID, 0);

    manager.query.mockClear();
    expect(
      (await codeOf(service.setSetlistItems('nope', { items: 'x' }))).code,
    ).toBe('VJ_SETLIST_NOT_FOUND');
    expect((await codeOf(service.setSetlistItems(SETLIST_ID, {}))).code).toBe(
      'VJ_SETLIST_ITEMS_INVALID',
    );
    expect(
      (
        await codeOf(
          service.setSetlistItems(SETLIST_ID, { sceneIds: [SCENE_ID] }),
        )
      ).code,
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
    expect(
      (
        await codeOf(
          service.setSetlistItems(SETLIST_ID, {
            sceneIds: [SCENE_ID],
            items: [sceneStep(SCENE_ID)],
          }),
        )
      ).code,
    ).toBe('VJ_SETLIST_ITEMS_INVALID');
    const full = await codeOf(
      service.setSetlistItems(SETLIST_ID.toUpperCase(), {
        items: Array.from({ length: VJ_LIMITS.setlistItemsMax + 1 }, () =>
          sceneStep(SCENE_ID),
        ),
      }),
    );
    expect(full.code).toBe('VJ_SETLIST_FULL');
    expect(full.body?.setlistId).toBe(SETLIST_ID);
    const badStep = await codeOf(
      service.setSetlistItems(SETLIST_ID, {
        items: [sceneStep(SCENE_ID, { clipId: CLIP_ID })],
      }),
    );
    expect(badStep).toEqual(
      expect.objectContaining({ code: 'VJ_SETLIST_STEP_INVALID', status: 400 }),
    );
    expect(
      (
        await codeOf(
          service.setSetlistItems(SETLIST_ID, {
            items: [clipStep(CLIP_ID, { duration: { kind: 'seconds' } })],
          }),
        )
      ).code,
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    expect(manager.query).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();

    expect(
      (
        await codeOf(
          service.setSetlistItems(UNKNOWN_SETLIST_ID, {
            items: [sceneStep(UNKNOWN_SCENE_ID, { id: UNKNOWN_ITEM_ID })],
          }),
        )
      ).code,
    ).toBe('VJ_SETLIST_NOT_FOUND');
    const unknownItem = await codeOf(
      service.setSetlistItems(SETLIST_ID, {
        items: [sceneStep(UNKNOWN_SCENE_ID, { id: UNKNOWN_ITEM_ID })],
      }),
    );
    expect(unknownItem).toEqual(
      expect.objectContaining({
        code: 'VJ_SETLIST_ITEM_NOT_FOUND',
        status: 404,
      }),
    );
    const foreignItem = await codeOf(
      service.setSetlistItems(SETLIST_ID, {
        items: [sceneStep(SCENE_ID, { id: foreignItemId })],
      }),
    );
    expect(foreignItem.code).toBe('VJ_SETLIST_ITEM_NOT_FOUND');
    const unknownScene = await codeOf(
      service.setSetlistItems(SETLIST_ID, {
        items: [
          clipStep(UNKNOWN_CLIP_ID),
          sceneStep(OTHER_SCENE_ID),
          sceneStep(UNKNOWN_SCENE_ID),
        ],
      }),
    );
    expect(unknownScene.code).toBe('VJ_SCENE_NOT_FOUND');
    expect(unknownScene.body?.sceneId).toBe(UNKNOWN_SCENE_ID);
    const unknownClip = await codeOf(
      service.setSetlistItems(SETLIST_ID, {
        items: [
          clipStep(CLIP_ID),
          clipStep(UNKNOWN_CLIP_ID),
          clipStep(uuidAt(4, 98)),
        ],
      }),
    );
    expect(unknownClip).toEqual(
      expect.objectContaining({ code: 'VJ_CLIP_NOT_FOUND', status: 404 }),
    );
    expect(unknownClip.body?.clipId).toBe(UNKNOWN_CLIP_ID);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('compares names case-insensitively after trim', async () => {
    storedSetlists.push(buildSetlist({ name: 'Friday set' }));
    storedSetlists.push(
      buildSetlist({ id: OTHER_SETLIST_ID, name: 'Closing', position: 1 }),
    );

    const taken = await codeOf(
      service.createSetlist(ADMIN, { name: '  FRIDAY SET  ' }),
    );
    expect(taken.code).toBe('VJ_SETLIST_NAME_TAKEN');
    expect(taken.body?.setlistId).toBe(SETLIST_ID);
    const holderLookups = manager.query.mock.calls.filter(
      (call: unknown[]) => call[0] === VJ_SETLIST_NAME_HOLDER_SQL,
    );
    expect(holderLookups.at(-1)).toEqual([
      VJ_SETLIST_NAME_HOLDER_SQL,
      ['FRIDAY SET', null],
    ]);

    const renameTaken = await codeOf(
      service.updateSetlist(SETLIST_ID, { name: ' closing ' }),
    );
    expect(renameTaken.code).toBe('VJ_SETLIST_NAME_TAKEN');
    expect(renameTaken.body?.setlistId).toBe(OTHER_SETLIST_ID);

    const unchanged = await service.updateSetlist(SETLIST_ID, {
      name: ' Friday set ',
    });
    expect(unchanged.name).toBe('Friday set');
    expect(manager.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    const renamed = await service.updateSetlist(SETLIST_ID, {
      name: 'FRIDAY SET',
    });
    expect(renamed.name).toBe('FRIDAY SET');
    expect(manager.update).toHaveBeenCalledWith(
      VjSetlist,
      { id: SETLIST_ID },
      { name: 'FRIDAY SET' },
    );
  });

  it('refuses the 51st set list', async () => {
    seedSetlists(VJ_LIMITS.setlistsMax);

    const outcome = await codeOf(
      service.createSetlist(ADMIN, { name: 'One more' }),
    );

    expect(outcome).toEqual(
      expect.objectContaining({
        code: 'VJ_SETLIST_LIMIT_REACHED',
        status: 409,
      }),
    );
    expect(storedSetlists).toHaveLength(VJ_LIMITS.setlistsMax);

    storedSetlists.pop();
    const created = await service.createSetlist(ADMIN, { name: 'One more' });
    expect(created.position).toBe(VJ_LIMITS.setlistsMax - 1);
  });

  it('checks a set list update in the contract order', async () => {
    storedSetlists.push(buildSetlist());
    const updateCode = async (
      setlistId: string,
      body: Record<string, unknown>,
    ) => (await codeOf(service.updateSetlist(setlistId, body))).code;

    expect(await updateCode('nope', {})).toBe('VJ_SETLIST_NOT_FOUND');
    const empty = await codeOf(service.updateSetlist(SETLIST_ID, {}));
    expect(empty).toEqual(
      expect.objectContaining({ code: 'VJ_SETLIST_PATCH_EMPTY', status: 400 }),
    );
    expect(await updateCode(SETLIST_ID, { name: ' ', isLooping: 'yes' })).toBe(
      'VJ_SETLIST_NAME_REQUIRED',
    );
    expect(await updateCode(SETLIST_ID, { name: 'x'.repeat(61) })).toBe(
      'VJ_SETLIST_NAME_TOO_LONG',
    );
    expect(
      await updateCode(SETLIST_ID, {
        isLooping: 1,
        stepDuration: { kind: 'beats', value: 3 },
      }),
    ).toBe('VJ_SETLIST_LOOP_INVALID');
    expect(
      await updateCode(SETLIST_ID, {
        stepDuration: { kind: 'beats', value: 3 },
      }),
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    expect(
      await updateCode(SETLIST_ID, { stepDuration: { kind: 'seconds' } }),
    ).toBe('VJ_SETLIST_STEP_DURATION_INVALID');
    expect(dataSource.transaction).not.toHaveBeenCalled();

    expect(await updateCode(UNKNOWN_SETLIST_ID, { isLooping: true })).toBe(
      'VJ_SETLIST_NOT_FOUND',
    );
    expect(manager.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('saves Loop and the step length, kind and value in one statement', async () => {
    storedSetlists.push(buildSetlist());

    const looped = await service.updateSetlist(SETLIST_ID.toUpperCase(), {
      isLooping: true,
    });
    expect(looped).toMatchObject({ id: SETLIST_ID, isLooping: true });
    expect(manager.update).toHaveBeenLastCalledWith(
      VjSetlist,
      { id: SETLIST_ID },
      { isLooping: true },
    );

    const lengthened = await service.updateSetlist(SETLIST_ID, {
      stepDuration: { kind: 'beats', value: 16 },
    });
    expect(lengthened.stepDuration).toEqual({ kind: 'beats', value: 16 });
    expect(manager.update).toHaveBeenLastCalledWith(
      VjSetlist,
      { id: SETLIST_ID },
      { stepDurationKind: 'beats', stepDurationValue: 16 },
    );

    await service.updateSetlist(SETLIST_ID, {
      stepDuration: { kind: 'seconds', value: 16 },
    });
    expect(manager.update).toHaveBeenLastCalledWith(
      VjSetlist,
      { id: SETLIST_ID },
      { stepDurationKind: 'seconds', stepDurationValue: 16 },
    );

    await service.updateSetlist(SETLIST_ID, {
      name: 'Saturday set',
      isLooping: false,
      stepDuration: { kind: 'seconds', value: 16 },
    });
    expect(manager.update).toHaveBeenLastCalledWith(
      VjSetlist,
      { id: SETLIST_ID },
      { name: 'Saturday set', isLooping: false },
    );
    expect(manager.update).toHaveBeenCalledTimes(4);
    expect(emittedChanges()).toEqual(
      Array.from({ length: 4 }, () =>
        fullChange({
          kind: 'setlist_updated',
          setlistId: SETLIST_ID,
          setlistIds: [SETLIST_ID],
        }),
      ),
    );

    manager.query.mockClear();
    const unchanged = await service.updateSetlist(SETLIST_ID, {
      name: 'Saturday set',
      isLooping: false,
      stepDuration: { kind: 'seconds', value: 16 },
    });
    expect(queriedSql()).not.toContain(VJ_SETLIST_NAME_HOLDER_SQL);
    expect(unchanged).toMatchObject({
      name: 'Saturday set',
      isLooping: false,
      stepDuration: { kind: 'seconds', value: 16 },
    });
    expect(manager.update).toHaveBeenCalledTimes(4);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(4);
  });

  it('answers the gateway Loop write through updateSetlist', async () => {
    storedSetlists.push(buildSetlist({ isLooping: true }));

    const kept = await service.updateSetlist(SETLIST_ID, { isLooping: true });
    expect(kept.isLooping).toBe(true);
    expect(manager.update).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    const missing = await codeOf(
      service.updateSetlist(UNKNOWN_SETLIST_ID, { isLooping: false }),
    );
    expect(missing).toEqual(
      expect.objectContaining({ code: 'VJ_SETLIST_NOT_FOUND', status: 404 }),
    );
    expect(operations).toContain(`query:${LOCK_VJ_SETLISTS_SQL}`);
  });

  it('keeps a repeated scene in the items', async () => {
    const created = await service.createSetlist(ADMIN, {
      name: 'Friday set',
      sceneIds: [SCENE_ID, OTHER_SCENE_ID.toUpperCase(), SCENE_ID],
    });

    expect(created.items.map((item) => [item.sceneId, item.position])).toEqual([
      [SCENE_ID, 0],
      [OTHER_SCENE_ID, 1],
      [SCENE_ID, 2],
    ]);
    expect(new Set(created.items.map((item) => item.id)).size).toBe(3);
    const shareReads = manager.query.mock.calls.filter(
      (call: unknown[]) => call[0] === VJ_SCENES_FOR_SHARE_SQL,
    );
    expect(shareReads).toEqual([
      [VJ_SCENES_FOR_SHARE_SQL, [[SCENE_ID, OTHER_SCENE_ID]]],
    ]);
  });

  it('keeps sent ids, inserts id-less steps, deletes left-out rows and bumps updated_at', async () => {
    storedSetlists.push(buildSetlist());
    storedSetlists.push(
      buildSetlist({ id: OTHER_SETLIST_ID, name: 'Closing', position: 1 }),
    );
    const firstId = seedItem(SETLIST_ID, SCENE_ID, 0);
    const secondId = seedItem(SETLIST_ID, OTHER_SCENE_ID, 1);
    const thirdId = seedClipItem(SETLIST_ID, CLIP_ID, 2);
    seedItem(OTHER_SETLIST_ID, SCENE_ID, 0);

    const updated = await service.setSetlistItems(SETLIST_ID, {
      items: [
        clipStep(OTHER_CLIP_ID),
        clipStep(CLIP_ID, {
          id: thirdId.toUpperCase(),
          duration: { kind: 'seconds', value: 12 },
        }),
        sceneStep(SCENE_ID, { id: firstId }),
      ],
    });

    expect(manager.delete).toHaveBeenCalledTimes(1);
    const [deletedEntity, deleteCriteria] = manager.delete.mock.calls[0] as [
      unknown,
      { id: FindOperator<string[]> },
    ];
    expect(deletedEntity).toBe(VjSetlistItem);
    expect(deleteCriteria.id.value).toEqual([secondId]);
    expect(manager.update).toHaveBeenCalledWith(
      VjSetlistItem,
      { id: thirdId },
      {
        kind: 'clip',
        sceneId: null,
        clipId: CLIP_ID,
        durationKind: 'seconds',
        durationValue: 12,
        position: 1,
      },
    );
    expect(manager.update).toHaveBeenCalledWith(
      VjSetlistItem,
      { id: firstId },
      {
        kind: 'scene',
        sceneId: SCENE_ID,
        clipId: null,
        durationKind: null,
        durationValue: null,
        position: 2,
      },
    );
    expect(manager.insert).toHaveBeenCalledWith(VjSetlistItem, [
      {
        setlistId: SETLIST_ID,
        kind: 'clip',
        sceneId: null,
        clipId: OTHER_CLIP_ID,
        durationKind: null,
        durationValue: null,
        position: 0,
      },
    ]);
    expect(manager.query).toHaveBeenCalledWith(TOUCH_VJ_SETLIST_SQL, [
      SETLIST_ID,
    ]);
    const insertedId = updated.items[0]?.id;
    expect(insertedId).toBeDefined();
    expect([firstId, secondId, thirdId]).not.toContain(insertedId);
    expect(
      updated.items.map((item) => [item.id, item.kind, item.position]),
    ).toEqual([
      [insertedId, 'clip', 0],
      [thirdId, 'clip', 1],
      [firstId, 'scene', 2],
    ]);
    expect(updated.items[1]?.duration).toEqual({ kind: 'seconds', value: 12 });
    expect(updated.updatedAt).toBe(LATER.toISOString());
    expect(storedStepsOf(OTHER_SETLIST_ID)).toHaveLength(1);
    expect(settledTransactions).toBe(1);

    const emptied = await service.setSetlistItems(SETLIST_ID, { items: [] });
    expect(emptied.items).toEqual([]);
  });

  it('turns a kept scene step into a clip step with kind and both targets in one update', async () => {
    storedSetlists.push(buildSetlist());
    const itemId = seedItem(SETLIST_ID, SCENE_ID, 0);

    const updated = await service.setSetlistItems(SETLIST_ID, {
      items: [
        clipStep(CLIP_ID, {
          id: itemId,
          duration: { kind: 'beats', value: 8 },
        }),
      ],
    });

    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      VjSetlistItem,
      { id: itemId },
      {
        kind: 'clip',
        sceneId: null,
        clipId: CLIP_ID,
        durationKind: 'beats',
        durationValue: 8,
        position: 0,
      },
    );
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(updated.items).toEqual([
      {
        id: itemId,
        position: 0,
        kind: 'clip',
        sceneId: null,
        clipId: CLIP_ID,
        duration: { kind: 'beats', value: 8 },
      },
    ]);
  });

  it('writes only the kept rows whose columns differ', async () => {
    storedSetlists.push(buildSetlist());
    const firstId = seedItem(SETLIST_ID, SCENE_ID, 0);
    const secondId = seedClipItem(SETLIST_ID, CLIP_ID, 1, {
      kind: 'beats',
      value: 4,
    });

    await service.setSetlistItems(SETLIST_ID, {
      items: [
        sceneStep(SCENE_ID, { id: firstId }),
        clipStep(CLIP_ID, {
          id: secondId,
          duration: { kind: 'beats', value: 4 },
        }),
        sceneStep(OTHER_SCENE_ID),
      ],
    });

    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.insert).toHaveBeenCalledTimes(1);
    expect(storedStepsOf(SETLIST_ID)).toEqual([
      [firstId, 'scene', SCENE_ID, 0],
      [secondId, 'clip', CLIP_ID, 1],
      [expect.any(String), 'scene', OTHER_SCENE_ID, 2],
    ]);
  });

  it('writes and emits nothing for the stored steps in the same order', async () => {
    storedSetlists.push(buildSetlist());
    const firstId = seedItem(SETLIST_ID, SCENE_ID, 0);
    const secondId = seedClipItem(SETLIST_ID, CLIP_ID, 1, {
      kind: 'seconds',
      value: 20,
    });
    const thirdId = seedItem(SETLIST_ID, SCENE_ID, 2);
    const storedBody = [
      sceneStep(SCENE_ID, { id: firstId.toUpperCase() }),
      clipStep(CLIP_ID.toUpperCase(), {
        id: secondId,
        duration: { kind: 'seconds', value: 20 },
      }),
      sceneStep(SCENE_ID, { id: thirdId, duration: null }),
    ];

    const unchanged = await service.setSetlistItems(SETLIST_ID, {
      items: storedBody,
    });

    expect(unchanged.items.map((item) => item.id)).toEqual([
      firstId,
      secondId,
      thirdId,
    ]);
    expect(unchanged.updatedAt).toBe(NOW.toISOString());
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
    expect(queriedSql()).not.toContain(TOUCH_VJ_SETLIST_SQL);
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    for (const changedBody of [
      [storedBody[0], storedBody[2], storedBody[1]],
      [
        storedBody[0],
        clipStep(CLIP_ID, {
          id: secondId,
          duration: { kind: 'beats', value: 8 },
        }),
        storedBody[2],
      ],
      [storedBody[0], clipStep(CLIP_ID, { id: secondId }), storedBody[2]],
      [
        storedBody[0],
        storedBody[1],
        sceneStep(OTHER_SCENE_ID, { id: thirdId }),
      ],
    ]) {
      eventEmitter.emit.mockClear();
      await service.setSetlistItems(SETLIST_ID, { items: changedBody });
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      await service.setSetlistItems(SETLIST_ID, { items: storedBody });
    }

    eventEmitter.emit.mockClear();
    await service.setSetlistItems(SETLIST_ID, {
      items: [storedBody[0], storedBody[1], sceneStep(SCENE_ID)],
    });
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(storedStepsOf(SETLIST_ID).map((step) => step[0])).not.toContain(
      thirdId,
    );
  });

  it('maps a scene or clip foreign key violation to its not-found code', async () => {
    storedSetlists.push(buildSetlist());
    manager.insert.mockRejectedValueOnce(
      foreignKeyViolation('FK_vj_setlist_items_scene'),
    );

    const outcome = await codeOf(
      service.setSetlistItems(SETLIST_ID, { items: [sceneStep(SCENE_ID)] }),
    );

    expect(outcome).toEqual(
      expect.objectContaining({ code: 'VJ_SCENE_NOT_FOUND', status: 404 }),
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    manager.insert.mockRejectedValueOnce(
      foreignKeyViolation('FK_vj_setlist_items_clip'),
    );
    const clipOutcome = await codeOf(
      service.setSetlistItems(SETLIST_ID, { items: [clipStep(CLIP_ID)] }),
    );
    expect(clipOutcome).toEqual(
      expect.objectContaining({ code: 'VJ_CLIP_NOT_FOUND', status: 404 }),
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();

    manager.insert.mockRejectedValueOnce(
      foreignKeyViolation('FK_vj_setlist_items_setlist'),
    );
    await expect(
      service.setSetlistItems(SETLIST_ID, { items: [sceneStep(SCENE_ID)] }),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('reads scenes then clips for key share before the set list row', async () => {
    storedSetlists.push(buildSetlist());
    seedItem(SETLIST_ID, OTHER_SCENE_ID, 0);

    await service.setSetlistItems(SETLIST_ID, {
      items: [sceneStep(SCENE_ID), clipStep(CLIP_ID), clipStep(CLIP_ID)],
    });

    const shareIndex = operations.indexOf(`query:${VJ_SCENES_FOR_SHARE_SQL}`);
    const clipShareIndex = operations.indexOf(
      `query:${VJ_CLIPS_FOR_SHARE_SQL}`,
    );
    const lockIndex = operations.indexOf(`query:${LOCK_VJ_SETLISTS_SQL}`);
    const rowIndex = operations.indexOf('findOne:VjSetlist:pessimistic_write');
    const deleteIndex = operations.indexOf('delete:VjSetlistItem');
    const insertIndex = operations.indexOf('insert:VjSetlistItem');
    expect(shareIndex).toBe(0);
    expect(clipShareIndex).toBe(1);
    expect(lockIndex).toBeGreaterThan(clipShareIndex);
    expect(rowIndex).toBeGreaterThan(lockIndex);
    expect(deleteIndex).toBeGreaterThan(rowIndex);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
    expect(manager.query).toHaveBeenCalledWith(VJ_CLIPS_FOR_SHARE_SQL, [
      [CLIP_ID],
    ]);
    expect(VJ_CLIPS_FOR_SHARE_SQL).toBe(
      'SELECT "id" FROM "vj_clips" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR KEY SHARE',
    );
    expect(VJ_SCENES_FOR_SHARE_SQL).toMatch(/ FOR KEY SHARE$/);
    // A clip delete locks the scenes naming the clip after the clip row;
    // that lock must let this key share read through, or a write naming
    // both the scene and the clip deadlocks against the delete.
    expect(VJ_SCENES_NAMING_CLIP_SQL).toMatch(/ FOR NO KEY UPDATE$/);

    operations = [];
    await service.createSetlist(ADMIN, {
      name: 'Closing',
      sceneIds: [OTHER_SCENE_ID],
    });
    expect(operations.slice(0, 2)).toEqual([
      `query:${VJ_SCENES_FOR_SHARE_SQL}`,
      `query:${LOCK_VJ_SETLISTS_SQL}`,
    ]);
  });

  it('renames, reorders and deletes with dense positions', async () => {
    seedSetlists(3);
    const [first, middle, last] = storedSetlists.map(
      (setlist) => setlist.id,
    ) as [string, string, string];
    seedItem(middle, SCENE_ID, 0);

    for (const setlistIds of [
      [first, middle],
      [first, middle, middle],
      [first, middle, UNKNOWN_SETLIST_ID],
      'nope',
    ]) {
      expect((await codeOf(service.reorderSetlists({ setlistIds }))).code).toBe(
        'VJ_SETLIST_REORDER_MISMATCH',
      );
    }
    expect(manager.update).not.toHaveBeenCalled();

    const reordered = await service.reorderSetlists({
      setlistIds: [last, first, middle],
    });
    expect(
      reordered.items.map((setlist) => [setlist.id, setlist.position]),
    ).toEqual([
      [last, 0],
      [first, 1],
      [middle, 2],
    ]);
    expect(reordered.items[2]?.items).toHaveLength(1);

    const renamed = await service.updateSetlist(first.toUpperCase(), {
      name: 'Warm up',
    });
    expect(renamed).toMatchObject({ id: first, name: 'Warm up', position: 1 });

    const deleted = await service.deleteSetlist(first);
    expect(deleted).toEqual({ deletedSetlistId: first });
    expect(manager.delete).toHaveBeenCalledWith(VjSetlist, { id: first });
    expect(queriedSql()).toContain(DENSIFY_VJ_SETLISTS_SQL);
    const listed = await service.listSetlists();
    expect(
      listed.items.map((setlist) => [setlist.id, setlist.position]),
    ).toEqual([
      [last, 0],
      [middle, 1],
    ]);

    expect((await codeOf(service.deleteSetlist(UNKNOWN_SETLIST_ID))).code).toBe(
      'VJ_SETLIST_NOT_FOUND',
    );
    manager.query.mockClear();
    expect((await codeOf(service.deleteSetlist('nope'))).code).toBe(
      'VJ_SETLIST_NOT_FOUND',
    );
    expect(
      (
        await codeOf(
          service.updateSetlist(UNKNOWN_SETLIST_ID, { name: 'Late' }),
        )
      ).code,
    ).toBe('VJ_SETLIST_NOT_FOUND');
  });

  it('emits the change kinds of the contract', async () => {
    storedSetlists.push(
      buildSetlist({ id: OTHER_SETLIST_ID, name: 'Closing', position: 0 }),
    );

    const created = await service.createSetlist(ADMIN, {
      name: 'Friday set',
      sceneIds: [SCENE_ID],
    });
    await service.updateSetlist(created.id, { name: 'Saturday set' });
    await service.setSetlistItems(created.id, {
      items: [clipStep(CLIP_ID)],
    });
    await service.reorderSetlists({
      setlistIds: [created.id, OTHER_SETLIST_ID],
    });
    await service.reorderSetlists({
      setlistIds: [created.id, OTHER_SETLIST_ID],
    });
    await service.deleteSetlist(created.id);

    expect(
      eventEmitter.emit.mock.calls.map((call: unknown[]) => call[0]),
    ).toEqual(Array.from({ length: 5 }, () => VJ_LIBRARY_CHANGED));
    expect(emittedChanges()).toEqual([
      fullChange({ kind: 'setlist_created', setlistId: CREATED_ID }),
      fullChange({
        kind: 'setlist_updated',
        setlistId: CREATED_ID,
        setlistIds: [CREATED_ID],
      }),
      fullChange({
        kind: 'setlist_items_changed',
        setlistId: CREATED_ID,
        setlistIds: [CREATED_ID],
      }),
      fullChange({ kind: 'setlists_reordered' }),
      fullChange({
        kind: 'setlist_deleted',
        setlistId: CREATED_ID,
        setlistIds: [CREATED_ID],
      }),
    ]);
    expect(settledAtEmit).toEqual([1, 2, 3, 4, 6]);
  });

  it('keeps refusal messages free of set list names', async () => {
    storedSetlists.push(buildSetlist({ name: 'Friday set' }));

    const outcomes = [
      await codeOf(service.createSetlist(ADMIN, { name: 'Friday set' })),
      await codeOf(service.updateSetlist(UNKNOWN_SETLIST_ID, { name: 'Late' })),
      await codeOf(
        service.createSetlist(ADMIN, {
          name: 'Late',
          sceneIds: [UNKNOWN_SCENE_ID],
        }),
      ),
    ];

    for (const outcome of outcomes) {
      const message = String(outcome.body?.message);
      expect(message).not.toContain('Friday set');
      expect(message).not.toContain('Late');
    }
  });
});
