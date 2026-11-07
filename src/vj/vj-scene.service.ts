import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import type {
  CreateVjSceneDto,
  ReorderVjScenesDto,
  UpdateVjSceneDto,
} from './dto/vj.dto';
import { VjScene } from './entities/vj-scene.entity';
import {
  normalizeIdPermutation,
  normalizeSceneName,
  readOptionalPackId,
} from './vj-input';
import {
  buildVjLibraryChange,
  DENSIFY_VJ_SCENES_SQL,
  DENSIFY_VJ_SETLIST_ITEMS_SQL,
  lowercaseIdOrRefuse,
  runVjTransaction,
  type VjCaller,
  type VjTransactionRefusals,
} from './vj-library-kit';
import { readVjCreatorProfiles } from './vj-library-reads';
import {
  toVjScene,
  type VjSceneDeletedDTO,
  type VjSceneDTO,
  type VjSceneListDTO,
} from './vj-response';
import { checkVjSceneLook, normalizeStoredVjSceneLook } from './vj-scene-look';
import { LOCK_VJ_SETLISTS_SQL } from './vj-setlist.service';
import { vjError } from './vj.constants';
import {
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
  type VjSceneLook,
} from './vj.contract';

/** Scene create, delete and reorder take this first, so the 200 cap and the
 *  dense positions hold under two admins writing at once (contract 6.2,
 *  plan note 8). */
export const LOCK_VJ_SCENES_SQL =
  'LOCK TABLE "vj_scenes" IN SHARE ROW EXCLUSIVE MODE';

/** Scene update, and the scene rewrite inside a clip delete, take this
 *  before any scene row, so their row updates wait behind a scene delete or
 *  reorder holding `LOCK_VJ_SCENES_SQL`, and never hold a scene row while
 *  they wait on that table lock. Row exclusive lets two of them run at
 *  once. */
export const LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL =
  'LOCK TABLE "vj_scenes" IN ROW EXCLUSIVE MODE';

/** `$1` scene ids. One `(scene_id, item_count)` row per scene that a set
 *  list item names; a scene no set list holds has no row. */
export const VJ_SCENE_ITEM_COUNTS_SQL = `SELECT "scene_id", COUNT(*)::int AS "item_count" FROM "vj_setlist_items" WHERE "scene_id" = ANY($1::uuid[]) GROUP BY "scene_id"`;

/** `$1` clip ids. The ids of the listed clips that exist, each held
 *  `FOR SHARE` until the scene write commits, so a clip delete waits for the
 *  write and its scene rewrite sees the new look (plan note 6). Runs before
 *  any scene lock. */
export const VJ_CLIPS_FOR_SHARE_SQL = `SELECT "id" FROM "vj_clips" WHERE "id" = ANY($1::uuid[]) FOR SHARE`;

/** `$1` a pack id. The pack's id when it exists, held `FOR SHARE` until the
 *  scene write commits. Runs before any scene lock, since a pack delete sets
 *  `pack_id` null on its scenes while it holds the pack row. */
export const VJ_PACK_FOR_SHARE_SQL = `SELECT "id" FROM "vj_packs" WHERE "id" = $1::uuid FOR SHARE`;

/** `$1` a scene id. The ids of the set lists holding the scene, read
 *  `FOR UPDATE` in id order, so a scene delete and a set list items write
 *  never densify the same set list at once. */
export const VJ_SETLISTS_HOLDING_SCENE_SQL = `SELECT "setlist"."id" FROM "vj_setlists" "setlist" WHERE EXISTS (SELECT 1 FROM "vj_setlist_items" "item" WHERE "item"."setlist_id" = "setlist"."id" AND "item"."scene_id" = $1::uuid) ORDER BY "setlist"."id" FOR UPDATE`;

/** `$1` a scene id. How many set list items name the scene. */
export const VJ_SCENE_ITEM_COUNT_SQL = `SELECT COUNT(*)::int AS "item_count" FROM "vj_setlist_items" WHERE "scene_id" = $1::uuid`;

/** A scene write that sets a pack another admin deleted mid-write. */
const SCENE_PACK_FOREIGN_KEY = 'FK_vj_scenes_pack';

/** The refusal a scene write's constraint violation answers. */
const SCENE_WRITE_REFUSALS: VjTransactionRefusals = {
  onForeignKey: new Map([
    [SCENE_PACK_FOREIGN_KEY, () => vjError('VJ_PACK_NOT_FOUND')],
  ]),
};

/** No constraint of a reorder or delete maps to a refusal. */
const NO_REFUSALS: VjTransactionRefusals = {};

/** The clips a checked look names. */
interface VjSceneClipIds {
  sourceClipId: string | null;
  mixClipId: string | null;
}

/** A scene write's fields after the checks that need no read. */
interface VjSceneUpdateFields {
  name: string | undefined;
  packId: string | null | undefined;
  look: VjSceneLook | undefined;
  clipIds: VjSceneClipIds;
}

/** One row of `VJ_SCENE_ITEM_COUNTS_SQL`. */
interface VjSceneItemCountRow {
  scene_id: string;
  item_count: number | string;
}

/** One row of a single `item_count` read. */
interface VjItemCountRow {
  item_count: number | string;
}

/** One row of an id read. */
interface VjIdRow {
  id: string;
}

/** What a scene delete hands back from its transaction. */
interface VjSceneDeleteOutcome {
  setlistIds: string[];
  removedFromSetlistCount: number;
}

const NO_SCENE_CLIPS: VjSceneClipIds = { sourceClipId: null, mixClipId: null };

/** The canonical look and the clips it names, or `VJ_SCENE_LOOK_INVALID`
 *  with the dot path of the first bad field. */
function checkLookOrRefuse(value: unknown): {
  look: VjSceneLook;
  clipIds: VjSceneClipIds;
} {
  const result = checkVjSceneLook(value);
  if (!result.isValid) {
    throw vjError('VJ_SCENE_LOOK_INVALID', { lookField: result.lookField });
  }
  return { look: result.look, clipIds: result.clipIds };
}

/** The distinct clip ids a look names, source first. */
function namedClipIdsOf(clipIds: VjSceneClipIds): string[] {
  const named = [clipIds.sourceClipId, clipIds.mixClipId].filter(
    (clipId): clipId is string => clipId !== null,
  );
  return [...new Set(named)];
}

/** Answers `VJ_SCENE_CLIP_NOT_FOUND` naming the source before the mix when
 *  a named clip is missing from the `FOR SHARE` read. */
function assertSceneClipsExist(
  clipIds: VjSceneClipIds,
  existingClipIds: ReadonlySet<string>,
): void {
  if (
    clipIds.sourceClipId !== null &&
    !existingClipIds.has(clipIds.sourceClipId)
  ) {
    throw vjError('VJ_SCENE_CLIP_NOT_FOUND', { lookField: 'source.clipId' });
  }
  if (clipIds.mixClipId !== null && !existingClipIds.has(clipIds.mixClipId)) {
    throw vjError('VJ_SCENE_CLIP_NOT_FOUND', { lookField: 'mix.clipId' });
  }
}

/** JSON with object keys sorted, so two looks compare by content whatever
 *  order their fields were built in. */
function stableJsonOf(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonOf(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonOf(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether a scene update leaves every stored field as it is (plan note 15). */
function isSameScene(scene: VjScene, fields: VjSceneUpdateFields): boolean {
  const isSameName = fields.name === undefined || fields.name === scene.name;
  const isSamePack =
    fields.packId === undefined || fields.packId === scene.packId;
  const isSameLook =
    fields.look === undefined ||
    stableJsonOf(fields.look) ===
      stableJsonOf(normalizeStoredVjSceneLook(scene.look));
  return isSameName && isSamePack && isSameLook;
}

/**
 * Scenes behind `admin/vj/scenes` (contract 6.2): saved looks a remote
 * recalls in one tap. Every refusal goes through `vjError` in the contract's
 * check order, and a malformed id answers its not-found code before any
 * read. Lock order (plan notes 6 and 8): the named clips and the pack are
 * read `FOR SHARE` before any scene lock; create, reorder and delete take
 * the scene table lock first. Positions stay dense (`0..n-1`); every write
 * emits `VJ_LIBRARY_CHANGED` after its transaction commits. Nothing logs a
 * scene name or a look.
 */
@Injectable()
export class VjSceneService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Every scene in `position, id` order, each look normalised. */
  async listScenes(): Promise<VjSceneListDTO> {
    const manager = this.dataSource.manager;
    const scenes = await manager.find(VjScene, {
      order: { position: 'ASC', id: 'ASC' },
    });
    return { items: await this.toSceneDtos(manager, scenes) };
  }

  /** Appends a scene at the end of the list. Name, pack id and look are
   *  checked before the transaction; the pack, the clips and the 200 cap run
   *  inside it. */
  async createScene(
    caller: VjCaller,
    body: CreateVjSceneDto,
  ): Promise<VjSceneDTO> {
    const name = normalizeSceneName(body.name);
    const packId = readOptionalPackId(body.packId) ?? null;
    const { look, clipIds } = checkLookOrRefuse(body.look);
    const sceneId = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const existingClipIds = await this.readClipsForShare(manager, clipIds);
        const isPackFound = await this.readPackForShare(manager, packId);
        await manager.query(LOCK_VJ_SCENES_SQL);
        if (!isPackFound) {
          throw vjError('VJ_PACK_NOT_FOUND');
        }
        assertSceneClipsExist(clipIds, existingClipIds);
        const sceneCount = await manager.count(VjScene);
        if (sceneCount >= VJ_LIMITS.scenesMax) {
          throw vjError('VJ_SCENE_LIMIT_REACHED');
        }
        const scene = manager.create(VjScene, {
          name,
          packId,
          position: sceneCount,
          look,
          createdByUserId: caller.userId,
        });
        const saved = await manager.save(VjScene, scene);
        return saved.id;
      },
      SCENE_WRITE_REFUSALS,
    );
    this.emitChange(buildVjLibraryChange('scene_created', { sceneId }));
    return this.readSceneDto(sceneId);
  }

  /** Updates a scene's name, pack or look; an absent field stays and a
   *  present look replaces the stored one whole. An empty body, or one equal
   *  to the stored row, writes nothing and emits nothing. The clip and pack
   *  `FOR SHARE` reads come first, then the row exclusive table lock, then
   *  the scene row. */
  async updateScene(
    requestedSceneId: string,
    body: UpdateVjSceneDto,
  ): Promise<VjSceneDTO> {
    const sceneId = lowercaseIdOrRefuse(requestedSceneId, 'VJ_SCENE_NOT_FOUND');
    const fields = this.readUpdateFields(body);
    if (
      fields.name === undefined &&
      fields.packId === undefined &&
      fields.look === undefined
    ) {
      return this.readSceneDto(sceneId);
    }
    const isUpdated = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const existingClipIds = await this.readClipsForShare(
          manager,
          fields.clipIds,
        );
        const isPackFound = await this.readPackForShare(
          manager,
          fields.packId ?? null,
        );
        await manager.query(LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL);
        const scene = await manager.findOne(VjScene, {
          where: { id: sceneId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!scene) {
          throw vjError('VJ_SCENE_NOT_FOUND');
        }
        if (!isPackFound) {
          throw vjError('VJ_PACK_NOT_FOUND');
        }
        assertSceneClipsExist(fields.clipIds, existingClipIds);
        if (isSameScene(scene, fields)) {
          return false;
        }
        await manager.update(
          VjScene,
          { id: sceneId },
          {
            ...(fields.name === undefined ? {} : { name: fields.name }),
            ...(fields.packId === undefined ? {} : { packId: fields.packId }),
            ...(fields.look === undefined ? {} : { look: fields.look }),
          },
        );
        return true;
      },
      SCENE_WRITE_REFUSALS,
    );
    if (isUpdated) {
      this.emitChange(buildVjLibraryChange('scene_updated', { sceneId }));
    }
    return this.readSceneDto(sceneId);
  }

  /** Rewrites every scene's position to its index in `sceneIds`, which must
   *  name every scene exactly once. A mismatch writes nothing; an unchanged
   *  order writes and emits nothing. */
  async reorderScenes(body: ReorderVjScenesDto): Promise<VjSceneListDTO> {
    const isReordered = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SCENES_SQL);
        const scenes = await manager.find(VjScene, {
          select: { id: true, position: true },
          order: { position: 'ASC', id: 'ASC' },
        });
        const orderedIds = normalizeIdPermutation(
          body.sceneIds,
          scenes.map((scene) => scene.id),
          'VJ_SCENE_REORDER_MISMATCH',
        );
        const positionById = new Map(
          scenes.map((scene) => [scene.id.toLowerCase(), scene.position]),
        );
        let hasChange = false;
        for (const [position, id] of orderedIds.entries()) {
          if (positionById.get(id) !== position) {
            await manager.update(VjScene, { id }, { position });
            hasChange = true;
          }
        }
        return hasChange;
      },
      NO_REFUSALS,
    );
    if (isReordered) {
      this.emitChange(buildVjLibraryChange('scenes_reordered', {}));
    }
    return this.listScenes();
  }

  /** Deletes a scene (its set list items cascade), then closes the gaps in
   *  the scene positions and in the item positions of each set list that
   *  held it. The set list table lock comes after the scene row and before
   *  the set list rows, the order a set list write takes it in. */
  async deleteScene(requestedSceneId: string): Promise<VjSceneDeletedDTO> {
    const sceneId = lowercaseIdOrRefuse(requestedSceneId, 'VJ_SCENE_NOT_FOUND');
    const outcome = await runVjTransaction<VjSceneDeleteOutcome>(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SCENES_SQL);
        const scene = await manager.findOne(VjScene, {
          where: { id: sceneId },
          select: { id: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (!scene) {
          throw vjError('VJ_SCENE_NOT_FOUND');
        }
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlistRows: VjIdRow[] = await manager.query(
          VJ_SETLISTS_HOLDING_SCENE_SQL,
          [sceneId],
        );
        const countRows: VjItemCountRow[] = await manager.query(
          VJ_SCENE_ITEM_COUNT_SQL,
          [sceneId],
        );
        await manager.delete(VjScene, { id: sceneId });
        await manager.query(DENSIFY_VJ_SCENES_SQL);
        const setlistIds = setlistRows.map((row) => row.id);
        if (setlistIds.length > 0) {
          await manager.query(DENSIFY_VJ_SETLIST_ITEMS_SQL, [setlistIds]);
        }
        return {
          setlistIds,
          removedFromSetlistCount: Number(countRows[0]?.item_count ?? 0),
        };
      },
      NO_REFUSALS,
    );
    this.emitChange(
      buildVjLibraryChange('scene_deleted', {
        sceneId,
        setlistIds: outcome.setlistIds,
      }),
    );
    return {
      deletedSceneId: sceneId,
      removedFromSetlistCount: outcome.removedFromSetlistCount,
    };
  }

  /** The update body's checks that need no read, in the contract's order:
   *  name, pack id, look. */
  private readUpdateFields(body: UpdateVjSceneDto): VjSceneUpdateFields {
    const name =
      body.name === undefined ? undefined : normalizeSceneName(body.name);
    const packId = readOptionalPackId(body.packId);
    if (body.look === undefined) {
      return { name, packId, look: undefined, clipIds: NO_SCENE_CLIPS };
    }
    const { look, clipIds } = checkLookOrRefuse(body.look);
    return { name, packId, look, clipIds };
  }

  /** The named clips that exist, read `FOR SHARE`; no read when the look
   *  names none. */
  private async readClipsForShare(
    manager: EntityManager,
    clipIds: VjSceneClipIds,
  ): Promise<Set<string>> {
    const namedClipIds = namedClipIdsOf(clipIds);
    if (namedClipIds.length === 0) {
      return new Set();
    }
    const rows: VjIdRow[] = await manager.query(VJ_CLIPS_FOR_SHARE_SQL, [
      namedClipIds,
    ]);
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  /** Whether the pack exists, read `FOR SHARE`; true with no read when the
   *  write names no pack. */
  private async readPackForShare(
    manager: EntityManager,
    packId: string | null,
  ): Promise<boolean> {
    if (packId === null) {
      return true;
    }
    const rows: VjIdRow[] = await manager.query(VJ_PACK_FOR_SHARE_SQL, [
      packId,
    ]);
    return rows.length > 0;
  }

  /** One scene's DTO; a scene gone since the write answers
   *  `VJ_SCENE_NOT_FOUND`. */
  private async readSceneDto(sceneId: string): Promise<VjSceneDTO> {
    const manager = this.dataSource.manager;
    const scene = await manager.findOne(VjScene, { where: { id: sceneId } });
    if (!scene) {
      throw vjError('VJ_SCENE_NOT_FOUND');
    }
    const [dto] = await this.toSceneDtos(manager, [scene]);
    if (!dto) {
      throw vjError('VJ_SCENE_NOT_FOUND');
    }
    return dto;
  }

  /** Scene DTOs with their set list item counts and creators, each read in
   *  one batch; every stored look passes the read normaliser. */
  private async toSceneDtos(
    manager: EntityManager,
    scenes: VjScene[],
  ): Promise<VjSceneDTO[]> {
    if (scenes.length === 0) {
      return [];
    }
    const countRows: VjSceneItemCountRow[] = await manager.query(
      VJ_SCENE_ITEM_COUNTS_SQL,
      [scenes.map((scene) => scene.id)],
    );
    const itemCountBySceneId = new Map(
      countRows.map((row) => [row.scene_id, Number(row.item_count)]),
    );
    const profiles = await readVjCreatorProfiles(
      manager,
      scenes.map((scene) => scene.createdByUserId),
    );
    return scenes.map((scene) =>
      toVjScene(
        scene,
        normalizeStoredVjSceneLook(scene.look),
        itemCountBySceneId.get(scene.id) ?? 0,
        profiles,
      ),
    );
  }

  /** Emits one library change after its transaction committed. */
  private emitChange(change: VjLibraryChange): void {
    this.eventEmitter.emit(VJ_LIBRARY_CHANGED, change);
  }
}
