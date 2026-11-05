import { HttpException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import type { CreateVjClipDto } from './dto/vj.dto';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import {
  DENSIFY_VJ_PACK_CLIPS_SQL,
  DENSIFY_VJ_PACKS_SQL,
  LOCK_VJ_CLIPS_SQL,
  LOCK_VJ_PACK_CLIPS_SQL,
  LOCK_VJ_PACKS_SQL,
  VJ_CLIP_PACK_IDS_SQL,
  VJ_PACK_NAME_HOLDER_SQL,
  VJ_PACK_SUMMARY_SQL,
  type VjCaller,
  VjLibraryService,
} from './vj-library.service';
import { VJ_LIBRARY_CHANGED, VJ_LIMITS } from './vj.contract';

const ADMIN_ID = 'a7100000-0000-4000-8000-000000000001';
const API_BASE_URL = 'https://api.example.test';
const NOW = new Date('2026-11-05T12:00:00.000Z');
const CLIP_TITLE = 'Glitter tunnel loop';

/** A v4 uuid in a numbered family: 1 packs, 2 clips, 3 and 4 key segments,
 *  9 rows the fake store creates. */
function uuidAt(family: number, position: number): string {
  return `a7100000-0000-4000-8000-${String(family)}${String(position).padStart(11, '0')}`;
}

const PACK_ID = uuidAt(1, 1);
const OTHER_PACK_ID = uuidAt(1, 2);
const CLIP_ID = uuidAt(2, 1);
const OTHER_CLIP_ID = uuidAt(2, 2);
const CREATED_ID = uuidAt(9, 1);

function clipKeyAt(position: number, extension: string): string {
  return `vj-clips/${uuidAt(3, position)}/${uuidAt(4, position)}${extension}`;
}

function thumbnailKeyAt(position: number): string {
  return `vj-thumbnails/${uuidAt(3, position)}/${uuidAt(4, position)}.webp`;
}

const CLIP_KEY = clipKeyAt(1, '.mp4');
const THUMBNAIL_KEY = thumbnailKeyAt(1);
const NEW_CLIP_KEY = clipKeyAt(7, '.mp4');
const NEW_THUMBNAIL_KEY = thumbnailKeyAt(7);

const ADMIN: VjCaller = { userId: ADMIN_ID };

/** First 16 bytes of an MP4 (`ftyp` box, `isom` brand). */
const MP4_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x02, 0x00,
]);
/** First 16 bytes of a QuickTime MOV (`ftyp` box, `qt  ` brand). */
const MOV_BYTES = Uint8Array.from([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00,
  0x00, 0x00, 0x00,
]);
/** First 16 bytes of a WebM (EBML header). */
const WEBM_BYTES = Uint8Array.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
  0x42, 0xf2, 0x81,
]);
/** First 16 bytes of a WebP (`RIFF....WEBP`). */
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);
/** First 16 bytes of a PNG. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

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

function buildPack(overrides: Partial<VjPack> = {}): VjPack {
  return {
    id: PACK_ID,
    name: 'Peak hour',
    position: 0,
    createdByUserId: ADMIN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as VjPack;
}

function buildClip(overrides: Partial<VjClip> = {}): VjClip {
  return {
    id: CLIP_ID,
    title: CLIP_TITLE,
    mediaKind: 'video',
    mimeType: 'video/mp4',
    byteSize: 2048,
    width: 1920,
    height: 1080,
    durationMs: 8000,
    storageKey: CLIP_KEY,
    thumbnailStorageKey: THUMBNAIL_KEY,
    fitMode: 'fill',
    createdByUserId: ADMIN_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as VjClip;
}

function buildMembership(
  packId: string,
  clipId: string,
  position: number,
): VjPackClip {
  return { packId, clipId, position, addedAt: NOW } as VjPackClip;
}

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

type Row = Record<string, unknown>;
type Criteria = Record<string, unknown>;
interface FindOptions {
  where?: Criteria;
  lock?: { mode: string };
}

describe('VjLibraryService', () => {
  beforeAll(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  let storedPacks: VjPack[];
  let storedClips: VjClip[];
  let storedMemberships: VjPackClip[];
  let storedProfiles: Profile[];
  let settledTransactions: number;
  let settledAtEmit: number[];
  let objectSizes: Map<string, number>;
  let objectBytes: Map<string, Uint8Array>;
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
    insert: jest.Mock;
  };
  let dataSource: { manager: typeof manager; transaction: jest.Mock };
  let storage: {
    describeObject: jest.Mock;
    readObjectPrefixBytes: jest.Mock;
    createPresignedVjClipDownload: jest.Mock;
    deleteObjectByKey: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let service: VjLibraryService;

  function rowsOf(entity: unknown): Row[] {
    if (entity === VjPack) return storedPacks as unknown as Row[];
    if (entity === VjClip) return storedClips as unknown as Row[];
    if (entity === VjPackClip) return storedMemberships as unknown as Row[];
    if (entity === Profile) return storedProfiles as unknown as Row[];
    throw new Error('Unexpected entity');
  }

  function matches(row: Row, criteria: Criteria | undefined): boolean {
    return Object.entries(criteria ?? {}).every(([field, expected]) =>
      expected instanceof FindOperator
        ? (expected.value as unknown[]).includes(row[field])
        : row[field] === expected,
    );
  }

  function packPosition(packId: unknown): number {
    return storedPacks.find((pack) => pack.id === packId)?.position ?? -1;
  }

  function findRows(entity: unknown, options?: FindOptions): Row[] {
    const rows = rowsOf(entity).filter((row) => matches(row, options?.where));
    if (entity === VjPack) {
      return [...rows].sort(
        (first, second) => Number(first.position) - Number(second.position),
      );
    }
    if (entity === VjPackClip) {
      return [...rows]
        .sort(
          (first, second) => Number(first.position) - Number(second.position),
        )
        .map((row) => ({
          ...row,
          clip: storedClips.find((clip) => clip.id === row.clipId),
        }));
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

  function summaryRows(packId: unknown): Row[] {
    return findRows(VjPack)
      .filter((pack) => packId === null || pack.id === packId)
      .map((pack) => {
        const members = findRows(VjPackClip, { where: { packId: pack.id } });
        const clips = members.map((member) => member.clip as VjClip);
        return {
          id: pack.id,
          name: pack.name,
          position: pack.position,
          created_by_user_id: pack.createdByUserId,
          created_at: pack.createdAt,
          updated_at: pack.updatedAt,
          clip_count: members.length,
          total_byte_size: String(
            clips.reduce((total, clip) => total + clip.byteSize, 0),
          ),
          cover_thumbnail_key: clips[0]?.thumbnailStorageKey ?? null,
        };
      });
  }

  function runQuery(sql: string, parameters: unknown[] = []): unknown[] {
    if (
      sql === LOCK_VJ_PACKS_SQL ||
      sql === LOCK_VJ_CLIPS_SQL ||
      sql === LOCK_VJ_PACK_CLIPS_SQL
    ) {
      return [];
    }
    if (sql === VJ_PACK_SUMMARY_SQL) {
      return summaryRows(parameters[0]);
    }
    if (sql === VJ_CLIP_PACK_IDS_SQL) {
      const clipIds = parameters[0] as string[];
      return storedMemberships
        .filter((membership) => clipIds.includes(membership.clipId))
        .sort(
          (first, second) =>
            packPosition(first.packId) - packPosition(second.packId),
        )
        .map((membership) => ({
          clip_id: membership.clipId,
          pack_id: membership.packId,
        }));
    }
    if (sql === VJ_PACK_NAME_HOLDER_SQL) {
      const [name, exceptId] = parameters as [string, string | null];
      return storedPacks
        .filter(
          (pack) =>
            pack.name.toLowerCase() === name.toLowerCase() &&
            pack.id !== exceptId,
        )
        .map((pack) => ({ id: pack.id }));
    }
    if (sql === DENSIFY_VJ_PACKS_SQL) {
      findRows(VjPack).forEach((pack, position) => {
        pack.position = position;
      });
      return [];
    }
    if (sql === DENSIFY_VJ_PACK_CLIPS_SQL) {
      for (const packId of parameters[0] as string[]) {
        findRows(VjPackClip, { where: { packId } }).forEach((row, position) => {
          const stored = storedMemberships.find(
            (membership) =>
              membership.packId === packId && membership.clipId === row.clipId,
          );
          if (stored) stored.position = position;
        });
      }
      return [];
    }
    throw new Error('Unexpected SQL');
  }

  /** The SQL text of every `manager.query` call, in order. */
  function queriedSql(): string[] {
    return manager.query.mock.calls.map((call: unknown[]) => call[0] as string);
  }

  /** The `findOne` calls whose target is the given entity. */
  function findOneOptionsOf(entity: unknown): FindOptions[] {
    return manager.findOne.mock.calls
      .filter((call: unknown[]) => call[0] === entity)
      .map((call: unknown[]) => call[1] as FindOptions);
  }

  /** A stored row whose save assigns a fresh id and timestamps. */
  function saveRow(entity: unknown, row: Row): Row {
    const saved: Row = {
      id: CREATED_ID,
      createdAt: NOW,
      updatedAt: NOW,
      ...row,
    };
    rowsOf(entity).push(saved);
    return saved;
  }

  beforeEach(() => {
    storedPacks = [];
    storedClips = [];
    storedMemberships = [];
    storedProfiles = [
      { userId: ADMIN_ID, firstName: 'Rui', lastName: 'Lopes' } as Profile,
    ];
    settledTransactions = 0;
    settledAtEmit = [];
    objectSizes = new Map();
    objectBytes = new Map();
    manager = {
      find: jest.fn((entity: unknown, options?: FindOptions) =>
        Promise.resolve(findRows(entity, options)),
      ),
      findOne: jest.fn((entity: unknown, options?: FindOptions) =>
        Promise.resolve(findRows(entity, options)[0] ?? null),
      ),
      count: jest.fn((entity: unknown, options?: FindOptions) =>
        Promise.resolve(findRows(entity, options).length),
      ),
      create: jest.fn((_entity: unknown, data: Row) => ({ ...data })),
      save: jest.fn((entity: unknown, row: Row) =>
        Promise.resolve(saveRow(entity, row)),
      ),
      update: jest.fn((entity: unknown, criteria: Criteria, values: Row) => {
        for (const row of rowsOf(entity).filter((candidate) =>
          matches(candidate, criteria),
        )) {
          Object.assign(row, values);
        }
        return Promise.resolve({ affected: 1 });
      }),
      delete: jest.fn((entity: unknown, criteria: Criteria) => {
        removeRows(entity, criteria);
        if (entity === VjPack) {
          removeRows(VjPackClip, { packId: criteria.id });
        }
        if (entity === VjClip) {
          removeRows(VjPackClip, { clipId: criteria.id });
        }
        return Promise.resolve({ affected: 1 });
      }),
      query: jest.fn((sql: string, parameters?: unknown[]) =>
        Promise.resolve(runQuery(sql, parameters)),
      ),
      insert: jest.fn((entity: unknown, row: Row) => {
        rowsOf(entity).push({ addedAt: NOW, ...row });
        return Promise.resolve({ identifiers: [] });
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
    storage = {
      describeObject: jest.fn((key: string) => {
        const size = objectSizes.get(key);
        return Promise.resolve(
          size === undefined ? null : { key, size, lastModified: null },
        );
      }),
      readObjectPrefixBytes: jest.fn((key: string) =>
        Promise.resolve(objectBytes.get(key) ?? new Uint8Array(0)),
      ),
      createPresignedVjClipDownload: jest.fn((key: string) =>
        Promise.resolve({
          url: `https://bucket.example.test/${key}?signature=1`,
          expiresAt: '2026-11-05T12:15:00.000Z',
        }),
      ),
      deleteObjectByKey: jest.fn(() => Promise.resolve()),
    };
    eventEmitter = {
      emit: jest.fn(() => {
        settledAtEmit.push(settledTransactions);
        return true;
      }),
    };
    service = new VjLibraryService(
      dataSource as unknown as DataSource,
      storage as unknown as StorageService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Seeds `count` packs at positions `0..count-1`. */
  function seedPacks(count: number): void {
    for (let position = 0; position < count; position += 1) {
      storedPacks.push(
        buildPack({
          id: uuidAt(1, position + 1),
          name: `Pack ${position}`,
          position,
        }),
      );
    }
  }

  /** Seeds the two uploads of a valid MP4 clip create. */
  function seedValidUploads(): void {
    objectSizes.set(NEW_CLIP_KEY, 5000);
    objectBytes.set(NEW_CLIP_KEY, MP4_BYTES);
    objectSizes.set(NEW_THUMBNAIL_KEY, 4000);
    objectBytes.set(NEW_THUMBNAIL_KEY, WEBP_BYTES);
  }

  function clipCreateBody(
    overrides: Partial<CreateVjClipDto> = {},
  ): CreateVjClipDto {
    return {
      title: CLIP_TITLE,
      storageKey: NEW_CLIP_KEY,
      thumbnailStorageKey: NEW_THUMBNAIL_KEY,
      width: 1280,
      height: 720,
      durationMs: 6000,
      ...overrides,
    };
  }

  describe('packs', () => {
    it('creates a pack at the end under the table lock', async () => {
      seedPacks(2);

      const pack = await service.createPack(ADMIN, { name: '  Warm up  ' });

      expect(queriedSql()[0]).toBe(LOCK_VJ_PACKS_SQL);
      expect(manager.save).toHaveBeenCalledWith(
        VjPack,
        expect.objectContaining({
          name: 'Warm up',
          position: 2,
          createdByUserId: ADMIN_ID,
        }),
      );
      expect(pack).toMatchObject({
        id: CREATED_ID,
        name: 'Warm up',
        position: 2,
        clipCount: 0,
        totalByteSize: 0,
        coverThumbnailUrl: null,
        createdBy: { userId: ADMIN_ID, displayName: 'Rui Lopes' },
      });
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_created',
        packId: CREATED_ID,
        clipId: null,
        packIds: [],
      });
      expect(settledAtEmit).toEqual([1]);
    });

    it('emits nothing when the pack create transaction rejects', async () => {
      manager.save.mockRejectedValueOnce(new Error('connection lost'));

      await expect(
        service.createPack(ADMIN, { name: 'Warm up' }),
      ).rejects.toThrow('connection lost');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('checks a pack create in the contract order', async () => {
      expect(await codeOf(service.createPack(ADMIN, { name: '   ' }))).toEqual(
        expect.objectContaining({ code: 'VJ_PACK_NAME_REQUIRED', status: 400 }),
      );
      expect(
        (await codeOf(service.createPack(ADMIN, { name: 'x'.repeat(61) })))
          .code,
      ).toBe('VJ_PACK_NAME_TOO_LONG');
      expect(dataSource.transaction).not.toHaveBeenCalled();

      seedPacks(VJ_LIMITS.packsMax);
      expect(
        (await codeOf(service.createPack(ADMIN, { name: 'Pack 0' }))).code,
      ).toBe('VJ_PACK_LIMIT_REACHED');

      storedPacks = [];
      seedPacks(3);
      const holder = storedPacks[1] as VjPack;
      holder.name = 'Peak hour';
      const outcome = await codeOf(
        service.createPack(ADMIN, { name: 'PEAK HOUR' }),
      );
      expect(outcome).toEqual(
        expect.objectContaining({ code: 'VJ_PACK_NAME_TAKEN', status: 409 }),
      );
      expect(outcome.body?.packId).toBe(holder.id);
      expect(manager.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('checks a rename in the contract order and treats the same name as a no-op', async () => {
      storedPacks.push(buildPack({ name: 'Peak hour' }));
      storedPacks.push(
        buildPack({ id: OTHER_PACK_ID, name: 'Closing', position: 1 }),
      );

      expect(
        (await codeOf(service.renamePack('nope', { name: '   ' }))).code,
      ).toBe('VJ_PACK_NOT_FOUND');
      expect(
        (await codeOf(service.renamePack(PACK_ID, { name: '   ' }))).code,
      ).toBe('VJ_PACK_NAME_REQUIRED');
      expect(
        (await codeOf(service.renamePack(PACK_ID, { name: 'x'.repeat(61) })))
          .code,
      ).toBe('VJ_PACK_NAME_TOO_LONG');
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(
        (await codeOf(service.renamePack(uuidAt(1, 99), { name: 'Late' })))
          .code,
      ).toBe('VJ_PACK_NOT_FOUND');

      const taken = await codeOf(
        service.renamePack(PACK_ID, { name: 'closing' }),
      );
      expect(taken.code).toBe('VJ_PACK_NAME_TAKEN');
      expect(taken.body?.packId).toBe(OTHER_PACK_ID);
      const holderLookups = manager.query.mock.calls.filter(
        (call: unknown[]) => call[0] === VJ_PACK_NAME_HOLDER_SQL,
      );
      expect(holderLookups.at(-1)).toEqual([
        VJ_PACK_NAME_HOLDER_SQL,
        ['closing', PACK_ID],
      ]);

      const unchanged = await service.renamePack(PACK_ID, {
        name: ' Peak hour ',
      });
      expect(unchanged.name).toBe('Peak hour');
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();

      const renamed = await service.renamePack(PACK_ID, { name: 'PEAK HOUR' });
      expect(renamed.name).toBe('PEAK HOUR');
      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: PACK_ID },
        { name: 'PEAK HOUR' },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_renamed',
        packId: PACK_ID,
        clipId: null,
        packIds: [],
      });
    });

    it('rewrites every position on a reorder and refuses a mismatch with no write', async () => {
      seedPacks(3);
      const [first, second, third] = storedPacks.map((pack) => pack.id) as [
        string,
        string,
        string,
      ];

      for (const packIds of [
        [first, second],
        [first, second, second],
        [first, second, uuidAt(1, 99)],
        'nope',
      ]) {
        expect((await codeOf(service.reorderPacks({ packIds }))).code).toBe(
          'VJ_PACK_REORDER_MISMATCH',
        );
      }
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();

      const reordered = await service.reorderPacks({
        packIds: [third, first, second],
      });

      expect(queriedSql()).toContain(LOCK_VJ_PACKS_SQL);
      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: third },
        { position: 0 },
      );
      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: first },
        { position: 1 },
      );
      expect(manager.update).toHaveBeenCalledWith(
        VjPack,
        { id: second },
        { position: 2 },
      );
      expect(reordered.items.map((pack) => pack.id)).toEqual([
        third,
        first,
        second,
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'packs_reordered',
        packId: null,
        clipId: null,
        packIds: [],
      });
    });

    it('deletes a pack, densifies the rest and counts the kept clips', async () => {
      seedPacks(3);
      const [first, middle, last] = storedPacks.map((pack) => pack.id) as [
        string,
        string,
        string,
      ];
      storedClips.push(buildClip(), buildClip({ id: OTHER_CLIP_ID }));
      storedMemberships.push(
        buildMembership(middle, CLIP_ID, 0),
        buildMembership(middle, OTHER_CLIP_ID, 1),
      );

      const deleted = await service.deletePack(middle);

      expect(deleted).toEqual({ deletedPackId: middle, clipsKeptCount: 2 });
      expect(manager.delete).toHaveBeenCalledWith(VjPack, { id: middle });
      expect(queriedSql()).toContain(DENSIFY_VJ_PACKS_SQL);
      expect(storedPacks.map((pack) => [pack.id, pack.position])).toEqual([
        [first, 0],
        [last, 1],
      ]);
      expect(storedClips).toHaveLength(2);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_deleted',
        packId: middle,
        clipId: null,
        packIds: [middle],
      });

      expect((await codeOf(service.deletePack(uuidAt(1, 99)))).status).toBe(
        404,
      );
      manager.query.mockClear();
      expect((await codeOf(service.deletePack('nope'))).code).toBe(
        'VJ_PACK_NOT_FOUND',
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('lists packs with counts, sizes, cover and creator', async () => {
      seedPacks(2);
      storedClips.push(
        buildClip({ byteSize: 1000 }),
        buildClip({
          id: OTHER_CLIP_ID,
          byteSize: 500,
          storageKey: clipKeyAt(2, '.gif'),
          thumbnailStorageKey: thumbnailKeyAt(2),
        }),
      );
      storedMemberships.push(
        buildMembership(PACK_ID, OTHER_CLIP_ID, 0),
        buildMembership(PACK_ID, CLIP_ID, 1),
      );

      const list = await service.listPacks();

      expect(list.items[0]).toMatchObject({
        id: PACK_ID,
        clipCount: 2,
        totalByteSize: 1500,
        coverThumbnailUrl: `${API_BASE_URL}/files/${thumbnailKeyAt(2)}`,
        createdBy: { userId: ADMIN_ID, displayName: 'Rui Lopes' },
      });
      expect(list.items[1]).toMatchObject({ clipCount: 0, totalByteSize: 0 });
      expect(
        manager.find.mock.calls.filter(
          (call: unknown[]) => call[0] === Profile,
        ),
      ).toHaveLength(1);
    });
  });

  describe('memberships', () => {
    it('checks an add in the contract order', async () => {
      storedPacks.push(buildPack());
      storedClips.push(buildClip(), buildClip({ id: OTHER_CLIP_ID }));
      storedMemberships.push(buildMembership(PACK_ID, CLIP_ID, 0));

      expect(
        (await codeOf(service.addPackClip('nope', { clipId: 'nope' }))).code,
      ).toBe('VJ_PACK_NOT_FOUND');
      expect(
        (await codeOf(service.addPackClip(uuidAt(1, 99), { clipId: 'nope' })))
          .code,
      ).toBe('VJ_PACK_NOT_FOUND');
      expect(
        (await codeOf(service.addPackClip(PACK_ID, { clipId: 'nope' }))).code,
      ).toBe('VJ_CLIP_NOT_FOUND');
      expect(
        (await codeOf(service.addPackClip(PACK_ID, { clipId: uuidAt(2, 99) })))
          .code,
      ).toBe('VJ_CLIP_NOT_FOUND');
      const already = await codeOf(
        service.addPackClip(PACK_ID, { clipId: CLIP_ID }),
      );
      expect(already).toEqual(
        expect.objectContaining({
          code: 'VJ_CLIP_ALREADY_IN_PACK',
          status: 409,
        }),
      );
      expect(already.body?.packId).toBe(PACK_ID);

      const fullPackId = OTHER_PACK_ID;
      storedPacks.push(
        buildPack({ id: fullPackId, name: 'Full', position: 1 }),
      );
      for (let position = 0; position < VJ_LIMITS.packClipsMax; position += 1) {
        storedMemberships.push(
          buildMembership(fullPackId, uuidAt(5, position), position),
        );
      }
      const full = await codeOf(
        service.addPackClip(fullPackId, { clipId: OTHER_CLIP_ID }),
      );
      expect(full).toEqual(
        expect.objectContaining({ code: 'VJ_PACK_FULL', status: 409 }),
      );
      expect(full.body?.packId).toBe(fullPackId);
      expect(manager.insert).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();

      const result = await service.addPackClip(PACK_ID, {
        clipId: OTHER_CLIP_ID,
      });

      for (const options of findOneOptionsOf(VjPack)) {
        expect(options.lock).toEqual({ mode: 'pessimistic_write' });
      }
      expect(manager.insert).toHaveBeenCalledWith(VjPackClip, {
        packId: PACK_ID,
        clipId: OTHER_CLIP_ID,
        position: 1,
      });
      expect(result.items.map((clip) => clip.id)).toEqual([
        CLIP_ID,
        OTHER_CLIP_ID,
      ]);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_clips_changed',
        packId: PACK_ID,
        clipId: OTHER_CLIP_ID,
        packIds: [PACK_ID],
      });
    });

    it('answers VJ_CLIP_NOT_FOUND when the clip is deleted before the membership insert', async () => {
      storedPacks.push(buildPack());
      storedClips.push(buildClip());
      manager.insert.mockRejectedValueOnce(
        foreignKeyViolation('FK_vj_pack_clips_clip'),
      );

      const outcome = await codeOf(
        service.addPackClip(PACK_ID, { clipId: CLIP_ID }),
      );

      expect(outcome).toEqual(
        expect.objectContaining({ code: 'VJ_CLIP_NOT_FOUND', status: 404 }),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rethrows a foreign key violation on any other constraint', async () => {
      storedPacks.push(buildPack());
      storedClips.push(buildClip());
      const violation = foreignKeyViolation('FK_vj_pack_clips_pack');
      manager.insert.mockRejectedValueOnce(violation);

      await expect(
        service.addPackClip(PACK_ID, { clipId: CLIP_ID }),
      ).rejects.toBe(violation);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('removes a clip from a pack and keeps it in the library', async () => {
      storedPacks.push(buildPack());
      storedClips.push(
        buildClip(),
        buildClip({
          id: OTHER_CLIP_ID,
          storageKey: clipKeyAt(2, '.mp4'),
          thumbnailStorageKey: thumbnailKeyAt(2),
        }),
      );
      storedMemberships.push(buildMembership(PACK_ID, CLIP_ID, 0));

      const outsider = await codeOf(
        service.removePackClip(PACK_ID, OTHER_CLIP_ID),
      );
      expect(outsider).toEqual(
        expect.objectContaining({ code: 'VJ_CLIP_NOT_IN_PACK', status: 404 }),
      );
      expect(outsider.body?.packId).toBe(PACK_ID);
      expect((await codeOf(service.removePackClip(PACK_ID, 'nope'))).code).toBe(
        'VJ_CLIP_NOT_FOUND',
      );

      storedMemberships.push(buildMembership(PACK_ID, OTHER_CLIP_ID, 1));
      const result = await service.removePackClip(PACK_ID, CLIP_ID);

      expect(manager.delete).toHaveBeenCalledTimes(1);
      expect(manager.delete).toHaveBeenCalledWith(VjPackClip, {
        packId: PACK_ID,
        clipId: CLIP_ID,
      });
      expect(manager.query).toHaveBeenCalledWith(DENSIFY_VJ_PACK_CLIPS_SQL, [
        [PACK_ID],
      ]);
      expect(storedClips.map((clip) => clip.id)).toEqual([
        CLIP_ID,
        OTHER_CLIP_ID,
      ]);
      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
      expect(result.items.map((clip) => [clip.id, clip.packIds])).toEqual([
        [OTHER_CLIP_ID, [PACK_ID]],
      ]);
      expect(storedMemberships[0]?.position).toBe(0);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_clips_changed',
        packId: PACK_ID,
        clipId: CLIP_ID,
        packIds: [PACK_ID],
      });
    });

    it('reorders pack clips as a permutation', async () => {
      storedPacks.push(buildPack());
      const thirdClipId = uuidAt(2, 3);
      storedClips.push(
        buildClip(),
        buildClip({ id: OTHER_CLIP_ID }),
        buildClip({ id: thirdClipId }),
      );
      storedMemberships.push(
        buildMembership(PACK_ID, CLIP_ID, 0),
        buildMembership(PACK_ID, OTHER_CLIP_ID, 1),
        buildMembership(PACK_ID, thirdClipId, 2),
      );

      expect(
        (
          await codeOf(
            service.reorderPackClips(PACK_ID, {
              clipIds: [CLIP_ID, CLIP_ID, OTHER_CLIP_ID],
            }),
          )
        ).code,
      ).toBe('VJ_PACK_CLIPS_REORDER_MISMATCH');
      expect(
        (
          await codeOf(
            service.reorderPackClips(uuidAt(1, 99), {
              clipIds: [CLIP_ID, OTHER_CLIP_ID, thirdClipId],
            }),
          )
        ).code,
      ).toBe('VJ_PACK_NOT_FOUND');
      expect(manager.update).not.toHaveBeenCalled();

      const result = await service.reorderPackClips(PACK_ID, {
        clipIds: [thirdClipId, CLIP_ID, OTHER_CLIP_ID],
      });

      expect(result.items.map((clip) => clip.id)).toEqual([
        thirdClipId,
        CLIP_ID,
        OTHER_CLIP_ID,
      ]);
      expect(manager.update).toHaveBeenCalledWith(
        VjPackClip,
        { packId: PACK_ID, clipId: thirdClipId },
        { position: 0 },
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_clips_changed',
        packId: PACK_ID,
        clipId: null,
        packIds: [PACK_ID],
      });
    });
  });

  describe('media', () => {
    beforeEach(() => {
      storedPacks.push(buildPack());
      storedClips.push(
        buildClip(),
        buildClip({
          id: OTHER_CLIP_ID,
          mimeType: 'image/gif',
          mediaKind: 'gif',
          durationMs: null,
          byteSize: 900,
          storageKey: clipKeyAt(2, '.gif'),
          thumbnailStorageKey: thumbnailKeyAt(2),
        }),
      );
      storedMemberships.push(
        buildMembership(PACK_ID, OTHER_CLIP_ID, 0),
        buildMembership(PACK_ID, CLIP_ID, 1),
      );
    });

    it('signs every clip of the pack in pack order and carries no storage key', async () => {
      const media = await service.getPackMedia(PACK_ID, {});

      expect(storage.createPresignedVjClipDownload).toHaveBeenCalledWith(
        clipKeyAt(2, '.gif'),
        'image/gif',
      );
      expect(storage.createPresignedVjClipDownload).toHaveBeenCalledWith(
        CLIP_KEY,
        'video/mp4',
      );
      expect(media.packId).toBe(PACK_ID);
      expect(media.items.map((item) => item.clipId)).toEqual([
        OTHER_CLIP_ID,
        CLIP_ID,
      ]);
      expect(media.items[0]).toEqual({
        clipId: OTHER_CLIP_ID,
        url: `https://bucket.example.test/${clipKeyAt(2, '.gif')}?signature=1`,
        expiresAt: '2026-11-05T12:15:00.000Z',
        mimeType: 'image/gif',
        byteSize: 900,
      });
      for (const item of media.items) {
        expect(item).not.toHaveProperty('storageKey');
      }
    });

    it('narrows to the listed ids that are in the pack', async () => {
      storedClips.push(buildClip({ id: uuidAt(2, 3) }));

      const media = await service.getPackMedia(PACK_ID, {
        clipIds: `${CLIP_ID},${uuidAt(2, 3)}`,
      });
      expect(media.items.map((item) => item.clipId)).toEqual([CLIP_ID]);

      manager.count.mockClear();
      expect(
        (await codeOf(service.getPackMedia(PACK_ID, { clipIds: 'nope' }))).code,
      ).toBe('VJ_CLIP_IDS_INVALID');
      expect(manager.count).toHaveBeenCalledTimes(1);

      expect(
        (await codeOf(service.getPackMedia(uuidAt(1, 99), { clipIds: 'nope' })))
          .code,
      ).toBe('VJ_PACK_NOT_FOUND');
    });
  });

  describe('clip create', () => {
    it('checks a clip create in the contract order', async () => {
      seedValidUploads();
      const codeFor = async (body: CreateVjClipDto) =>
        codeOf(service.createClip(ADMIN, body));

      expect((await codeFor(clipCreateBody({ title: ' ' }))).code).toBe(
        'VJ_CLIP_TITLE_REQUIRED',
      );
      expect(
        (await codeFor(clipCreateBody({ storageKey: 'avatars/x.png' }))).body
          ?.field,
      ).toBe('storageKey');
      expect((await codeFor(clipCreateBody({ packId: 'nope' }))).code).toBe(
        'VJ_PACK_NOT_FOUND',
      );
      expect(storage.describeObject).not.toHaveBeenCalled();

      objectSizes.delete(NEW_CLIP_KEY);
      const missing = await codeFor(clipCreateBody());
      expect(missing).toEqual(
        expect.objectContaining({ code: 'VJ_UPLOAD_MISSING', status: 409 }),
      );
      expect(missing.body?.field).toBe('storageKey');

      objectSizes.set(NEW_CLIP_KEY, 0);
      expect(await codeFor(clipCreateBody())).toEqual(
        expect.objectContaining({ code: 'VJ_UPLOAD_CONTENT_MISMATCH' }),
      );

      objectSizes.set(NEW_CLIP_KEY, 104857601);
      const tooLarge = await codeFor(clipCreateBody());
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body).toMatchObject({
        code: 'VJ_UPLOAD_TOO_LARGE',
        kind: 'vj_clip',
        maxBytes: VJ_LIMITS.clipMaxBytes,
        field: 'storageKey',
      });

      objectSizes.set(NEW_CLIP_KEY, 5000);
      objectBytes.set(NEW_CLIP_KEY, MOV_BYTES);
      expect((await codeFor(clipCreateBody())).code).toBe(
        'VJ_UPLOAD_FORMAT_MOV',
      );

      objectBytes.set(NEW_CLIP_KEY, WEBM_BYTES);
      expect((await codeFor(clipCreateBody())).body).toMatchObject({
        code: 'VJ_UPLOAD_CONTENT_MISMATCH',
        field: 'storageKey',
      });

      objectBytes.set(NEW_CLIP_KEY, MP4_BYTES);
      const thumbnailOutcomes: [() => void, string][] = [
        [() => objectSizes.delete(NEW_THUMBNAIL_KEY), 'VJ_UPLOAD_MISSING'],
        [
          () => objectSizes.set(NEW_THUMBNAIL_KEY, 0),
          'VJ_UPLOAD_CONTENT_MISMATCH',
        ],
        [
          () => objectSizes.set(NEW_THUMBNAIL_KEY, 262145),
          'VJ_UPLOAD_TOO_LARGE',
        ],
        [
          () => {
            objectSizes.set(NEW_THUMBNAIL_KEY, 4000);
            objectBytes.set(NEW_THUMBNAIL_KEY, PNG_BYTES);
          },
          'VJ_UPLOAD_CONTENT_MISMATCH',
        ],
      ];
      for (const [arrange, expectedCode] of thumbnailOutcomes) {
        arrange();
        const outcome = await codeFor(clipCreateBody());
        expect(outcome.code).toBe(expectedCode);
        expect(outcome.body?.field).toBe('thumbnailStorageKey');
      }
      expect(dataSource.transaction).not.toHaveBeenCalled();

      objectBytes.set(NEW_THUMBNAIL_KEY, WEBP_BYTES);
      for (
        let position = 0;
        position < VJ_LIMITS.libraryClipsMax;
        position += 1
      ) {
        storedClips.push(buildClip({ id: uuidAt(6, position) }));
      }
      expect((await codeFor(clipCreateBody())).code).toBe('VJ_LIBRARY_FULL');
      expect(queriedSql()).toContain(LOCK_VJ_CLIPS_SQL);

      storedClips = [buildClip({ storageKey: NEW_CLIP_KEY })];
      expect((await codeFor(clipCreateBody())).body).toMatchObject({
        code: 'VJ_CLIP_KEY_IN_USE',
        field: 'storageKey',
      });
      storedClips = [buildClip({ thumbnailStorageKey: NEW_THUMBNAIL_KEY })];
      expect((await codeFor(clipCreateBody())).body).toMatchObject({
        code: 'VJ_CLIP_KEY_IN_USE',
        field: 'thumbnailStorageKey',
      });

      storedClips = [];
      expect(
        (await codeFor(clipCreateBody({ packId: uuidAt(1, 99) }))).code,
      ).toBe('VJ_PACK_NOT_FOUND');

      storedPacks.push(buildPack());
      for (let position = 0; position < VJ_LIMITS.packClipsMax; position += 1) {
        storedMemberships.push(
          buildMembership(PACK_ID, uuidAt(5, position), position),
        );
      }
      const full = await codeFor(clipCreateBody({ packId: PACK_ID }));
      expect(full.body).toMatchObject({
        code: 'VJ_PACK_FULL',
        packId: PACK_ID,
      });
      expect(manager.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('deletes both uploads after a MOV refusal', async () => {
      seedValidUploads();
      objectBytes.set(NEW_CLIP_KEY, MOV_BYTES);

      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_FORMAT_MOV');

      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_CLIP_KEY);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_THUMBNAIL_KEY);
    });

    it('deletes both uploads after VJ_UPLOAD_CONTENT_MISMATCH and VJ_UPLOAD_TOO_LARGE', async () => {
      seedValidUploads();
      objectBytes.set(NEW_THUMBNAIL_KEY, PNG_BYTES);
      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_CONTENT_MISMATCH');
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_CLIP_KEY);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_THUMBNAIL_KEY);

      storage.deleteObjectByKey.mockClear();
      seedValidUploads();
      objectSizes.set(NEW_CLIP_KEY, VJ_LIMITS.clipMaxBytes + 1);
      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_TOO_LARGE');
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_CLIP_KEY);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(NEW_THUMBNAIL_KEY);
    });

    it('keeps an upload key another clip already holds when a refusal discards uploads', async () => {
      seedValidUploads();
      objectBytes.set(NEW_CLIP_KEY, MOV_BYTES);
      storedClips.push(buildClip({ thumbnailStorageKey: NEW_THUMBNAIL_KEY }));

      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_FORMAT_MOV');
      expect(storage.deleteObjectByKey.mock.calls).toEqual([[NEW_CLIP_KEY]]);

      storage.deleteObjectByKey.mockClear();
      storedClips = [buildClip({ storageKey: NEW_CLIP_KEY })];
      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_FORMAT_MOV');
      expect(storage.deleteObjectByKey.mock.calls).toEqual([
        [NEW_THUMBNAIL_KEY],
      ]);
    });

    it('leaves both uploads after a missing object or a full library', async () => {
      seedValidUploads();
      objectSizes.delete(NEW_THUMBNAIL_KEY);
      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_UPLOAD_MISSING');

      seedValidUploads();
      for (
        let position = 0;
        position < VJ_LIMITS.libraryClipsMax;
        position += 1
      ) {
        storedClips.push(buildClip({ id: uuidAt(6, position) }));
      }
      expect(
        (await codeOf(service.createClip(ADMIN, clipCreateBody()))).code,
      ).toBe('VJ_LIBRARY_FULL');

      expect(storage.deleteObjectByKey).not.toHaveBeenCalled();
    });

    it('reads storage only for keys that passed the VJ key check', async () => {
      seedValidUploads();
      await codeOf(
        service.createClip(
          ADMIN,
          clipCreateBody({ thumbnailStorageKey: 'avatars/../x.webp' }),
        ),
      );
      expect(storage.describeObject).not.toHaveBeenCalled();
      expect(storage.readObjectPrefixBytes).not.toHaveBeenCalled();

      await service.createClip(ADMIN, clipCreateBody());
      expect(storage.readObjectPrefixBytes.mock.calls).toEqual([
        [NEW_CLIP_KEY],
        [NEW_THUMBNAIL_KEY],
      ]);
    });

    it('stores the type from the key and the size from storage', async () => {
      seedValidUploads();
      storedPacks.push(buildPack());
      storedClips.push(buildClip());
      storedMemberships.push(buildMembership(PACK_ID, CLIP_ID, 0));

      const created = await service.createClip(
        ADMIN,
        clipCreateBody({ packId: PACK_ID, fitMode: 'fit' }),
      );

      expect(manager.save).toHaveBeenCalledWith(
        VjClip,
        expect.objectContaining({
          title: CLIP_TITLE,
          mimeType: 'video/mp4',
          mediaKind: 'video',
          byteSize: 5000,
          fitMode: 'fit',
          createdByUserId: ADMIN_ID,
        }),
      );
      expect(manager.insert).toHaveBeenCalledWith(VjPackClip, {
        packId: PACK_ID,
        clipId: CREATED_ID,
        position: 1,
      });
      expect(created).toMatchObject({
        id: CREATED_ID,
        packIds: [PACK_ID],
        packCount: 1,
        thumbnailUrl: `${API_BASE_URL}/files/${NEW_THUMBNAIL_KEY}`,
      });
      expect(created).not.toHaveProperty('storageKey');
      expect(findOneOptionsOf(VjPack)[0]?.lock).toEqual({
        mode: 'pessimistic_write',
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'pack_clips_changed',
        packId: PACK_ID,
        clipId: CREATED_ID,
        packIds: [PACK_ID],
      });
      expect(settledAtEmit).toEqual([1]);
    });

    it('emits clip_created for a clip created with no pack', async () => {
      seedValidUploads();

      const created = await service.createClip(ADMIN, clipCreateBody());

      expect(created.packIds).toEqual([]);
      expect(created.fitMode).toBe('fill');
      expect(manager.insert).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'clip_created',
        packId: null,
        clipId: CREATED_ID,
        packIds: [],
      });
    });

    it('answers VJ_CLIP_KEY_IN_USE when the unique index fires', async () => {
      seedValidUploads();
      manager.save.mockRejectedValueOnce(
        uniqueViolation('UQ_vj_clips_thumbnail_storage_key'),
      );

      const outcome = await codeOf(service.createClip(ADMIN, clipCreateBody()));

      expect(outcome.status).toBe(409);
      expect(outcome.body).toMatchObject({
        code: 'VJ_CLIP_KEY_IN_USE',
        field: 'thumbnailStorageKey',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rethrows a unique violation on any other constraint', async () => {
      seedValidUploads();
      const violation = uniqueViolation('PK_vj_clips');
      manager.save.mockRejectedValueOnce(violation);

      await expect(service.createClip(ADMIN, clipCreateBody())).rejects.toBe(
        violation,
      );
    });
  });

  describe('clip update and delete', () => {
    it('answers the current clip for an empty update', async () => {
      storedClips.push(buildClip());

      const clip = await service.updateClip(CLIP_ID, {});

      expect(clip).toMatchObject({ id: CLIP_ID, title: CLIP_TITLE });
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect((await codeOf(service.updateClip('nope', {}))).code).toBe(
        'VJ_CLIP_NOT_FOUND',
      );
      expect((await codeOf(service.updateClip(uuidAt(2, 99), {}))).code).toBe(
        'VJ_CLIP_NOT_FOUND',
      );
    });

    it('checks an update in the contract order', async () => {
      storedClips.push(buildClip());

      expect(
        (await codeOf(service.updateClip('nope', { title: ' ' }))).code,
      ).toBe('VJ_CLIP_NOT_FOUND');
      expect(
        (await codeOf(service.updateClip(uuidAt(2, 99), { title: ' ' }))).code,
      ).toBe('VJ_CLIP_TITLE_REQUIRED');
      expect(
        (await codeOf(service.updateClip(CLIP_ID, { fitMode: 'stretch' })))
          .code,
      ).toBe('VJ_CLIP_FIT_MODE_INVALID');
      expect(
        (await codeOf(service.updateClip(uuidAt(2, 99), { title: 'Late' })))
          .code,
      ).toBe('VJ_CLIP_NOT_FOUND');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('updates title and fit mode and names every pack holding the clip', async () => {
      storedPacks.push(
        buildPack(),
        buildPack({ id: OTHER_PACK_ID, name: 'Closing', position: 1 }),
      );
      storedClips.push(buildClip());
      storedMemberships.push(
        buildMembership(OTHER_PACK_ID, CLIP_ID, 0),
        buildMembership(PACK_ID, CLIP_ID, 3),
      );

      const clip = await service.updateClip(CLIP_ID, {
        title: '  Neon rain ',
        fitMode: 'fit',
      });

      expect(manager.update).toHaveBeenCalledWith(
        VjClip,
        { id: CLIP_ID },
        { title: 'Neon rain', fitMode: 'fit' },
      );
      expect(clip).toMatchObject({
        title: 'Neon rain',
        fitMode: 'fit',
        packIds: [PACK_ID, OTHER_PACK_ID],
        packCount: 2,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'clip_updated',
        packId: null,
        clipId: CLIP_ID,
        packIds: [PACK_ID, OTHER_PACK_ID],
      });
      expect(queriedSql()).toContain(VJ_CLIP_PACK_IDS_SQL);
    });

    it('deletes a clip, densifies its packs and then both objects', async () => {
      storedPacks.push(
        buildPack(),
        buildPack({ id: OTHER_PACK_ID, name: 'Closing', position: 1 }),
      );
      storedClips.push(buildClip(), buildClip({ id: OTHER_CLIP_ID }));
      storedMemberships.push(
        buildMembership(PACK_ID, CLIP_ID, 0),
        buildMembership(PACK_ID, OTHER_CLIP_ID, 1),
        buildMembership(OTHER_PACK_ID, CLIP_ID, 0),
      );

      const deleted = await service.deleteClip(CLIP_ID);

      expect(deleted).toEqual({
        deletedClipId: CLIP_ID,
        removedFromPackCount: 2,
      });
      expect(findOneOptionsOf(VjClip)[0]).toMatchObject({
        where: { id: CLIP_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.query).toHaveBeenCalledWith(DENSIFY_VJ_PACK_CLIPS_SQL, [
        [PACK_ID, OTHER_PACK_ID],
      ]);
      expect(storedMemberships).toEqual([
        expect.objectContaining({ clipId: OTHER_CLIP_ID, position: 0 }),
      ]);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(CLIP_KEY);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(THUMBNAIL_KEY);
      const transactionOrder = dataSource.transaction.mock
        .invocationCallOrder[0] as number;
      for (const callOrder of storage.deleteObjectByKey.mock
        .invocationCallOrder) {
        expect(callOrder).toBeGreaterThan(transactionOrder);
      }
      expect(settledTransactions).toBe(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(VJ_LIBRARY_CHANGED, {
        kind: 'clip_deleted',
        packId: null,
        clipId: CLIP_ID,
        packIds: [PACK_ID, OTHER_PACK_ID],
      });

      expect((await codeOf(service.deleteClip('nope'))).code).toBe(
        'VJ_CLIP_NOT_FOUND',
      );
      expect((await codeOf(service.deleteClip(uuidAt(2, 99)))).status).toBe(
        404,
      );
    });

    it('locks the clip table and then the membership table before any membership write on a clip delete', async () => {
      storedPacks.push(buildPack());
      storedClips.push(buildClip(), buildClip({ id: OTHER_CLIP_ID }));
      storedMemberships.push(
        buildMembership(PACK_ID, CLIP_ID, 0),
        buildMembership(PACK_ID, OTHER_CLIP_ID, 1),
      );

      await service.deleteClip(CLIP_ID);

      expect(queriedSql().slice(0, 2)).toEqual([
        LOCK_VJ_CLIPS_SQL,
        LOCK_VJ_PACK_CLIPS_SQL,
      ]);
      const membershipLockOrder = manager.query.mock.invocationCallOrder[1];
      const densifyIndex = queriedSql().indexOf(DENSIFY_VJ_PACK_CLIPS_SQL);
      const densifyOrder = manager.query.mock.invocationCallOrder[densifyIndex];
      const deleteOrder = manager.delete.mock.invocationCallOrder[0];
      const clipReadOrder = manager.findOne.mock.invocationCallOrder[0];
      if (
        membershipLockOrder === undefined ||
        densifyOrder === undefined ||
        deleteOrder === undefined ||
        clipReadOrder === undefined
      ) {
        throw new Error('A delete step never ran');
      }
      expect(membershipLockOrder).toBeLessThan(clipReadOrder);
      expect(membershipLockOrder).toBeLessThan(deleteOrder);
      expect(membershipLockOrder).toBeLessThan(densifyOrder);
    });

    it('logs a failed object delete with the key only', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const otherLogSpies = [
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
        jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined),
        jest
          .spyOn(Logger.prototype, 'debug')
          .mockImplementation(() => undefined),
      ];
      storedClips.push(buildClip());
      storage.deleteObjectByKey.mockRejectedValueOnce(
        new Error(`delete failed for ${CLIP_TITLE}`),
      );

      const deleted = await service.deleteClip(CLIP_ID);

      expect(deleted.deletedClipId).toBe(CLIP_ID);
      expect(storage.deleteObjectByKey).toHaveBeenCalledWith(THUMBNAIL_KEY);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('VJ object delete failed');
      expect(message).toContain(CLIP_KEY);
      const everyArgument = JSON.stringify([
        warn.mock.calls,
        ...otherLogSpies.map((spy) => spy.mock.calls),
        eventEmitter.emit.mock.calls,
      ]);
      expect(everyArgument).not.toContain(CLIP_TITLE);
    });
  });

  describe('ids', () => {
    it('lowercases an uppercase id from a route or body before events and responses', async () => {
      storedPacks.push(
        buildPack(),
        buildPack({ id: OTHER_PACK_ID, name: 'Closing', position: 1 }),
      );
      storedClips.push(buildClip(), buildClip({ id: OTHER_CLIP_ID }));
      storedMemberships.push(buildMembership(PACK_ID, CLIP_ID, 0));

      const added = await service.addPackClip(PACK_ID.toUpperCase(), {
        clipId: OTHER_CLIP_ID.toUpperCase(),
      });
      expect(added.pack.id).toBe(PACK_ID);
      expect(added.items.map((clip) => clip.id)).toEqual([
        CLIP_ID,
        OTHER_CLIP_ID,
      ]);
      expect(manager.insert).toHaveBeenCalledWith(VjPackClip, {
        packId: PACK_ID,
        clipId: OTHER_CLIP_ID,
        position: 1,
      });

      const removed = await service.removePackClip(
        PACK_ID.toUpperCase(),
        OTHER_CLIP_ID.toUpperCase(),
      );
      expect(removed.items.map((clip) => clip.id)).toEqual([CLIP_ID]);

      const renamed = await service.renamePack(PACK_ID.toUpperCase(), {
        name: 'Sunrise',
      });
      expect(renamed.id).toBe(PACK_ID);

      const updated = await service.updateClip(CLIP_ID.toUpperCase(), {
        fitMode: 'fit',
      });
      expect(updated.id).toBe(CLIP_ID);

      const deletedPack = await service.deletePack(OTHER_PACK_ID.toUpperCase());
      expect(deletedPack.deletedPackId).toBe(OTHER_PACK_ID);

      const deletedClip = await service.deleteClip(CLIP_ID.toUpperCase());
      expect(deletedClip).toEqual({
        deletedClipId: CLIP_ID,
        removedFromPackCount: 1,
      });

      const emitted = eventEmitter.emit.mock.calls.map(
        (call: unknown[]) => call[1] as Record<string, unknown>,
      );
      expect(emitted).toEqual([
        {
          kind: 'pack_clips_changed',
          packId: PACK_ID,
          clipId: OTHER_CLIP_ID,
          packIds: [PACK_ID],
        },
        {
          kind: 'pack_clips_changed',
          packId: PACK_ID,
          clipId: OTHER_CLIP_ID,
          packIds: [PACK_ID],
        },
        {
          kind: 'pack_renamed',
          packId: PACK_ID,
          clipId: null,
          packIds: [],
        },
        {
          kind: 'clip_updated',
          packId: null,
          clipId: CLIP_ID,
          packIds: [PACK_ID],
        },
        {
          kind: 'pack_deleted',
          packId: OTHER_PACK_ID,
          clipId: null,
          packIds: [OTHER_PACK_ID],
        },
        {
          kind: 'clip_deleted',
          packId: null,
          clipId: CLIP_ID,
          packIds: [PACK_ID],
        },
      ]);
      expect(await service.packExists(PACK_ID.toUpperCase())).toBe(true);
      expect(await service.clipExists(OTHER_CLIP_ID.toUpperCase())).toBe(true);
    });
  });

  describe('lookups', () => {
    it('answers the socket lookups with one read each and no query for a malformed id', async () => {
      storedPacks.push(buildPack());
      storedClips.push(buildClip());
      storedMemberships.push(buildMembership(PACK_ID, CLIP_ID, 0));

      expect(await service.packExists(PACK_ID)).toBe(true);
      expect(await service.packExists(OTHER_PACK_ID)).toBe(false);
      expect(await service.clipExists(CLIP_ID)).toBe(true);
      expect(await service.clipExists(OTHER_CLIP_ID)).toBe(false);
      expect(await service.isClipInPack(PACK_ID, CLIP_ID)).toBe(true);
      expect(await service.isClipInPack(PACK_ID, OTHER_CLIP_ID)).toBe(false);
      expect(manager.count).toHaveBeenCalledTimes(6);
      expect(manager.count).toHaveBeenNthCalledWith(1, VjPack, {
        where: { id: PACK_ID },
      });
      expect(manager.count).toHaveBeenNthCalledWith(5, VjPackClip, {
        where: { packId: PACK_ID, clipId: CLIP_ID },
      });

      manager.count.mockClear();
      expect(await service.packExists('nope')).toBe(false);
      expect(await service.clipExists('nope')).toBe(false);
      expect(await service.isClipInPack(PACK_ID, 'nope')).toBe(false);
      expect(await service.isClipInPack('nope', CLIP_ID)).toBe(false);
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.findOne).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });
  });
});
