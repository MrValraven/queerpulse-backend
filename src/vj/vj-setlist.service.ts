import { HttpException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import type {
  CreateVjSetlistDto,
  ReorderVjSetlistsDto,
  SetVjSetlistItemsDto,
  UpdateVjSetlistDto,
} from './dto/vj.dto';
import { VjSetlistItem } from './entities/vj-setlist-item.entity';
import { VjSetlist } from './entities/vj-setlist.entity';
import {
  normalizeIdPermutation,
  normalizeSetlistItems,
  normalizeSetlistLooping,
  normalizeSetlistName,
  normalizeSetlistSceneIds,
  normalizeStepDuration,
  type VjSetlistItemEntry,
} from './vj-input';
import {
  buildVjLibraryChange,
  DENSIFY_VJ_SETLISTS_SQL,
  lowercaseIdOrRefuse,
  runVjTransaction,
  type VjCaller,
  type VjTransactionRefusals,
} from './vj-library-kit';
import { readVjCreatorProfiles } from './vj-library-reads';
import {
  toVjSetlist,
  type VjSetlistDeletedDTO,
  type VjSetlistDTO,
  type VjSetlistItemRow,
  type VjSetlistListDTO,
} from './vj-response';
import { vjError } from './vj.constants';
import {
  DEFAULT_VJ_STEP_DURATION,
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
  type VjSetlistItemKind,
  type VjStepDuration,
  type VjStepDurationKind,
} from './vj.contract';

/** Set list create, update, reorder, item write and delete take this, so
 *  the 50 cap, the case-insensitive name check and the dense positions hold
 *  under two admins writing at once. The item write takes it before the
 *  set list row, so its `updated_at` bump never waits on a delete that holds
 *  the table and waits on the row. A scene or clip delete takes it after its
 *  own row (contract 4.5). */
export const LOCK_VJ_SETLISTS_SQL =
  'LOCK TABLE "vj_setlists" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` trimmed name, `$2` the set list to skip or null: the id of another
 *  set list holding the name, compared with `lower()`. */
export const VJ_SETLIST_NAME_HOLDER_SQL = `SELECT "id" FROM "vj_setlists" WHERE lower("name") = lower($1) AND ($2::uuid IS NULL OR "id" <> $2::uuid) LIMIT 1`;

/** `$1` scene ids. Reads the named scenes `FOR KEY SHARE` in id order, before
 *  any set list lock, so a scene delete (which holds its scene row
 *  `FOR UPDATE` and then the set lists naming it) serialises with the write
 *  on the scene row. Key share lets a scene delete's position densify run
 *  past these rows, which a plain share lock would deadlock against. */
export const VJ_SCENES_FOR_SHARE_SQL = `SELECT "id" FROM "vj_scenes" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR KEY SHARE`;

/** `$1` clip ids. The clip twin of `VJ_SCENES_FOR_SHARE_SQL`, read right
 *  after it and before any set list lock. A clip delete holds its clip row
 *  `FOR UPDATE`, then locks the scenes whose look names the clip, then takes
 *  the set list lock (contract 4.5). A set list write naming one of those
 *  scenes already holds it in key share when it waits here on the deleted
 *  clip's row, so the delete's scene lock is `FOR NO KEY UPDATE`
 *  (`VJ_SCENES_NAMING_CLIP_SQL`), which key share never blocks: the delete
 *  runs on, commits, and this read finds the clip gone. With that pairing
 *  the two serialise on the clip row without a cycle. Key share also lets a
 *  clip edit (no key column) run past these rows. Same name as the scene
 *  service's plain share read of clips for scene looks, which is a
 *  different query; this one is the set list write's. */
export const VJ_CLIPS_FOR_SHARE_SQL = `SELECT "id" FROM "vj_clips" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR KEY SHARE`;

/** `$1` set list id. Bumps `updated_at` after an item write, which writes
 *  no set list column itself. */
export const TOUCH_VJ_SETLIST_SQL = `UPDATE "vj_setlists" SET "updated_at" = now() WHERE "id" = $1`;

/** An item write naming a scene or clip a delete removed answers
 *  `VJ_SCENE_NOT_FOUND` or `VJ_CLIP_NOT_FOUND`. The violation carries no
 *  readable id, so the refusal names none. */
const SETLIST_REFUSALS: VjTransactionRefusals = {
  onForeignKey: new Map<string, () => HttpException>([
    ['FK_vj_setlist_items_scene', () => vjError('VJ_SCENE_NOT_FOUND')],
    ['FK_vj_setlist_items_clip', () => vjError('VJ_CLIP_NOT_FOUND')],
  ]),
};

/** One stored step as the item write compares and rewrites it. */
interface VjStoredSetlistItem {
  id: string;
  kind: VjSetlistItemKind;
  sceneId: string | null;
  clipId: string | null;
  durationKind: VjStepDurationKind | null;
  durationValue: number | null;
  position: number;
}

/** The columns one step writes, in insert or in-place update. Kind and both
 *  targets always travel together, so a scene step turned clip step meets
 *  `CHK_vj_setlist_items_kind` in one statement (contract call 25). */
interface VjSetlistItemColumns {
  kind: VjSetlistItemKind;
  sceneId: string | null;
  clipId: string | null;
  durationKind: VjStepDurationKind | null;
  durationValue: number | null;
  position: number;
}

/** The set list columns a PATCH may change. The length's kind and value
 *  always travel together for `CHK_vj_setlists_step_duration`. */
interface VjSetlistUpdateColumns {
  name?: string;
  isLooping?: boolean;
  stepDurationKind?: VjStepDurationKind;
  stepDurationValue?: number;
}

/** A PATCH body after its field rules: each defined field checked. */
interface VjSetlistUpdateFields {
  name?: string;
  isLooping?: boolean;
  stepDuration?: VjStepDuration;
}

/**
 * VJ set lists behind `admin/vj/setlists`, shown to people as sequences:
 * named, ordered runs of scene and clip steps a remote steps through or
 * plays itself. Names are unique ignoring case; set list positions and item
 * positions stay dense (`0..n-1`); a scene or clip may sit in one set list
 * more than once. Field rules run before any read, in the contract's check
 * order. Named scenes, then named clips, are read `FOR KEY SHARE` before any
 * set list lock. Every write emits `VJ_LIBRARY_CHANGED` after its
 * transaction commits. Nothing logs a set list name.
 */
@Injectable()
export class VjSetlistService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Every set list in position order, each with its items. */
  async listSetlists(): Promise<VjSetlistListDTO> {
    const manager = this.dataSource.manager;
    const setlists = await manager.find(VjSetlist, {
      order: { position: 'ASC', id: 'ASC' },
    });
    return { items: await this.toSetlistDtos(manager, setlists) };
  }

  /** Appends a set list with its steps at `0..n-1`. The field rules run
   *  before the transaction in contract 4.4 order: name, both lists sent,
   *  `sceneIds` or `items`, `isLooping`, `stepDuration`, then any step `id`
   *  (a new set list holds no item to keep). The cap, the name clash and
   *  the scene then clip ids run under the table lock. Absent `isLooping`
   *  and `stepDuration` take false and `DEFAULT_VJ_STEP_DURATION`. */
  async createSetlist(
    caller: VjCaller,
    body: CreateVjSetlistDto,
  ): Promise<VjSetlistDTO> {
    const name = normalizeSetlistName(body.name);
    if (body.sceneIds !== undefined && body.items !== undefined) {
      throw vjError('VJ_SETLIST_ITEMS_INVALID');
    }
    const entries =
      body.items !== undefined
        ? normalizeSetlistItems(body.items, null)
        : sceneStepEntries(
            normalizeSetlistSceneIds(
              body.sceneIds === undefined ? [] : body.sceneIds,
              null,
            ),
          );
    const isLooping =
      body.isLooping === undefined
        ? false
        : normalizeSetlistLooping(body.isLooping);
    const stepDuration =
      body.stepDuration === undefined
        ? DEFAULT_VJ_STEP_DURATION
        : normalizeStepDuration(body.stepDuration);
    if (entries.some((entry) => entry.id !== null)) {
      throw vjError('VJ_SETLIST_ITEM_NOT_FOUND');
    }
    const sceneIds = entrySceneIds(entries);
    const clipIds = entryClipIds(entries);
    const setlistId = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const foundSceneIds = await this.shareTargets(
          manager,
          VJ_SCENES_FOR_SHARE_SQL,
          sceneIds,
        );
        const foundClipIds = await this.shareTargets(
          manager,
          VJ_CLIPS_FOR_SHARE_SQL,
          clipIds,
        );
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlistCount = await manager.count(VjSetlist);
        if (setlistCount >= VJ_LIMITS.setlistsMax) {
          throw vjError('VJ_SETLIST_LIMIT_REACHED');
        }
        await this.assertNameFree(manager, name, null);
        assertScenesFound(sceneIds, foundSceneIds);
        assertClipsFound(clipIds, foundClipIds);
        const setlist = manager.create(VjSetlist, {
          name,
          position: setlistCount,
          isLooping,
          stepDurationKind: stepDuration.kind,
          stepDurationValue: stepDuration.value,
          createdByUserId: caller.userId,
        });
        const saved = await manager.save(VjSetlist, setlist);
        await this.insertItems(
          manager,
          saved.id,
          entries.map((entry, position) => itemColumnsOf(entry, position)),
        );
        return saved.id;
      },
      SETLIST_REFUSALS,
    );
    this.emitChange(buildVjLibraryChange('setlist_created', { setlistId }));
    return this.readSetlist(setlistId);
  }

  /** `PATCH setlists/:id`, and the `stage:setlistSetLooping` write the
   *  gateway runs (contract 5.6, which passes `{ isLooping }`). Contract 4.4
   *  order: route id (`VJ_SETLIST_NOT_FOUND`), no field defined
   *  (`VJ_SETLIST_PATCH_EMPTY`), `name`, `isLooping`, `stepDuration`; then
   *  under the table lock the row (`VJ_SETLIST_NOT_FOUND`) and
   *  `VJ_SETLIST_NAME_TAKEN` when the name changes. A case-only name change
   *  is a change. Every field equal to the stored one writes nothing and
   *  emits nothing; a change emits `setlist_updated`. */
  async updateSetlist(
    requestedSetlistId: string,
    body: UpdateVjSetlistDto,
  ): Promise<VjSetlistDTO> {
    const setlistId = lowercaseIdOrRefuse(
      requestedSetlistId,
      'VJ_SETLIST_NOT_FOUND',
    );
    const fields = readUpdateFields(body);
    const isUpdated = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlist = await manager.findOne(VjSetlist, {
          where: { id: setlistId },
          select: {
            id: true,
            name: true,
            isLooping: true,
            stepDurationKind: true,
            stepDurationValue: true,
          },
        });
        if (!setlist) {
          throw vjError('VJ_SETLIST_NOT_FOUND');
        }
        const columns = changedSetlistColumns(setlist, fields);
        if (Object.keys(columns).length === 0) {
          return false;
        }
        if (columns.name !== undefined) {
          await this.assertNameFree(manager, columns.name, setlistId);
        }
        await manager.update(VjSetlist, { id: setlistId }, columns);
        return true;
      },
      SETLIST_REFUSALS,
    );
    if (isUpdated) {
      this.emitChange(
        buildVjLibraryChange('setlist_updated', {
          setlistId,
          setlistIds: [setlistId],
        }),
      );
    }
    return this.readSetlist(setlistId);
  }

  /** Rewrites every set list's position to its index in `setlistIds`,
   *  which must name every set list exactly once. A mismatch writes
   *  nothing; an unchanged order emits nothing. */
  async reorderSetlists(body: ReorderVjSetlistsDto): Promise<VjSetlistListDTO> {
    const isReordered = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlists = await manager.find(VjSetlist, {
          select: { id: true, position: true },
          order: { position: 'ASC', id: 'ASC' },
        });
        const orderedIds = normalizeIdPermutation(
          body.setlistIds,
          setlists.map((setlist) => setlist.id),
          'VJ_SETLIST_REORDER_MISMATCH',
        );
        const positionById = new Map(
          setlists.map((setlist) => [setlist.id, setlist.position]),
        );
        let hasChange = false;
        for (const [position, id] of orderedIds.entries()) {
          if (positionById.get(id) !== position) {
            await manager.update(VjSetlist, { id }, { position });
            hasChange = true;
          }
        }
        return hasChange;
      },
      SETLIST_REFUSALS,
    );
    if (isReordered) {
      this.emitChange(buildVjLibraryChange('setlists_reordered', {}));
    }
    return this.listSetlists();
  }

  /** Writes the whole step list (`PUT setlists/:id/items`, contract 4.4).
   *  An entry with an `id` keeps that stored item, updated in place; one
   *  without is inserted; a stored item the body leaves out is deleted;
   *  every row's position becomes its body index; `updated_at` is bumped.
   *  Scenes then clips are read `FOR KEY SHARE` before the table lock and
   *  the set list row. Refusals after the body rules: an `id` naming no
   *  item of this set list (`VJ_SETLIST_ITEM_NOT_FOUND`), the first missing
   *  scene (`VJ_SCENE_NOT_FOUND` with `sceneId`), the first missing clip
   *  (`VJ_CLIP_NOT_FOUND` with `clipId`). The old `{ sceneIds }` body
   *  answers `VJ_SETLIST_ITEMS_INVALID`. A body equal to the stored list
   *  writes nothing and emits nothing. */
  async setSetlistItems(
    requestedSetlistId: string,
    body: SetVjSetlistItemsDto,
  ): Promise<VjSetlistDTO> {
    const setlistId = lowercaseIdOrRefuse(
      requestedSetlistId,
      'VJ_SETLIST_NOT_FOUND',
    );
    if (body.sceneIds !== undefined) {
      throw vjError('VJ_SETLIST_ITEMS_INVALID');
    }
    const entries = normalizeSetlistItems(body.items, setlistId);
    const sceneIds = entrySceneIds(entries);
    const clipIds = entryClipIds(entries);
    const isChanged = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const foundSceneIds = await this.shareTargets(
          manager,
          VJ_SCENES_FOR_SHARE_SQL,
          sceneIds,
        );
        const foundClipIds = await this.shareTargets(
          manager,
          VJ_CLIPS_FOR_SHARE_SQL,
          clipIds,
        );
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        await this.lockSetlist(manager, setlistId);
        const storedItems = await this.readStoredItems(manager, setlistId);
        const storedIds = new Set(storedItems.map((item) => item.id));
        if (
          entries.some((entry) => entry.id !== null && !storedIds.has(entry.id))
        ) {
          throw vjError('VJ_SETLIST_ITEM_NOT_FOUND');
        }
        assertScenesFound(sceneIds, foundSceneIds);
        assertClipsFound(clipIds, foundClipIds);
        if (isStoredStepList(storedItems, entries)) {
          return false;
        }
        await this.writeItems(manager, setlistId, storedItems, entries);
        await manager.query(TOUCH_VJ_SETLIST_SQL, [setlistId]);
        return true;
      },
      SETLIST_REFUSALS,
    );
    if (isChanged) {
      this.emitChange(
        buildVjLibraryChange('setlist_items_changed', {
          setlistId,
          setlistIds: [setlistId],
        }),
      );
    }
    return this.readSetlist(setlistId);
  }

  /** Deletes a set list (its items cascade) and closes the gap in the set
   *  list positions. The scenes it named stay. */
  async deleteSetlist(
    requestedSetlistId: string,
  ): Promise<VjSetlistDeletedDTO> {
    const setlistId = lowercaseIdOrRefuse(
      requestedSetlistId,
      'VJ_SETLIST_NOT_FOUND',
    );
    await runVjTransaction(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        await this.lockSetlist(manager, setlistId);
        await manager.delete(VjSetlist, { id: setlistId });
        await manager.query(DENSIFY_VJ_SETLISTS_SQL);
      },
      SETLIST_REFUSALS,
    );
    this.emitChange(
      buildVjLibraryChange('setlist_deleted', {
        setlistId,
        setlistIds: [setlistId],
      }),
    );
    return { deletedSetlistId: setlistId };
  }

  /** Reads the named scenes or clips `FOR KEY SHARE` with `sql`
   *  (`VJ_SCENES_FOR_SHARE_SQL` or `VJ_CLIPS_FOR_SHARE_SQL`) and answers the
   *  ids that exist. No read for an empty list. */
  private async shareTargets(
    manager: EntityManager,
    sql: string,
    targetIds: readonly string[],
  ): Promise<Set<string>> {
    if (targetIds.length === 0) {
      return new Set();
    }
    const uniqueIds = [...new Set(targetIds)];
    const rows: { id: string }[] = await manager.query(sql, [uniqueIds]);
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  /** Reads the set list row `FOR UPDATE`; an unknown id answers
   *  `VJ_SETLIST_NOT_FOUND`. */
  private async lockSetlist(
    manager: EntityManager,
    setlistId: string,
  ): Promise<void> {
    const setlist = await manager.findOne(VjSetlist, {
      where: { id: setlistId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!setlist) {
      throw vjError('VJ_SETLIST_NOT_FOUND');
    }
  }

  /** A set list holding the same name ignoring case, other than `exceptId`,
   *  answers `VJ_SETLIST_NAME_TAKEN` with the holder's id. */
  private async assertNameFree(
    manager: EntityManager,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const holders: { id: string }[] = await manager.query(
      VJ_SETLIST_NAME_HOLDER_SQL,
      [name, exceptId],
    );
    const holder = holders[0];
    if (holder) {
      throw vjError('VJ_SETLIST_NAME_TAKEN', { setlistId: holder.id });
    }
  }

  /** The set list's stored steps in `position, id` order, ids lowercased,
   *  read under the set list row lock. */
  private async readStoredItems(
    manager: EntityManager,
    setlistId: string,
  ): Promise<VjStoredSetlistItem[]> {
    const items = await manager.find(VjSetlistItem, {
      where: { setlistId },
      select: {
        id: true,
        kind: true,
        sceneId: true,
        clipId: true,
        durationKind: true,
        durationValue: true,
        position: true,
      },
      order: { position: 'ASC', id: 'ASC' },
    });
    return items.map((item) => ({
      id: item.id.toLowerCase(),
      kind: item.kind,
      sceneId: item.sceneId === null ? null : item.sceneId.toLowerCase(),
      clipId: item.clipId === null ? null : item.clipId.toLowerCase(),
      durationKind: item.durationKind,
      durationValue:
        item.durationValue === null ? null : Number(item.durationValue),
      position: Number(item.position),
    }));
  }

  /** The changed list's rows, in contract 4.4 order: delete the stored rows
   *  the body leaves out, update each kept row whose columns differ (kind,
   *  both targets, length and position in one statement), insert the
   *  id-less entries. Every row's position is its body index. */
  private async writeItems(
    manager: EntityManager,
    setlistId: string,
    storedItems: readonly VjStoredSetlistItem[],
    entries: readonly VjSetlistItemEntry[],
  ): Promise<void> {
    const keptIds = new Set(
      entries
        .map((entry) => entry.id)
        .filter((itemId): itemId is string => itemId !== null),
    );
    const removedIds = storedItems
      .map((item) => item.id)
      .filter((itemId) => !keptIds.has(itemId));
    if (removedIds.length > 0) {
      await manager.delete(VjSetlistItem, { id: In(removedIds) });
    }
    const storedById = new Map(storedItems.map((item) => [item.id, item]));
    const insertedRows: VjSetlistItemColumns[] = [];
    for (const [position, entry] of entries.entries()) {
      const columns = itemColumnsOf(entry, position);
      if (entry.id === null) {
        insertedRows.push(columns);
        continue;
      }
      const stored = storedById.get(entry.id);
      if (stored && !isSameItemColumns(stored, columns)) {
        await manager.update(VjSetlistItem, { id: entry.id }, columns);
      }
    }
    await this.insertItems(manager, setlistId, insertedRows);
  }

  /** Inserts the given step rows; nothing for an empty list. */
  private async insertItems(
    manager: EntityManager,
    setlistId: string,
    rows: readonly VjSetlistItemColumns[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await manager.insert(
      VjSetlistItem,
      rows.map((columns) => ({ setlistId, ...columns })),
    );
  }

  /** One set list's DTO; a set list gone since the write answers
   *  `VJ_SETLIST_NOT_FOUND`. */
  private async readSetlist(setlistId: string): Promise<VjSetlistDTO> {
    const manager = this.dataSource.manager;
    const setlist = await manager.findOne(VjSetlist, {
      where: { id: setlistId },
    });
    if (!setlist) {
      throw vjError('VJ_SETLIST_NOT_FOUND');
    }
    const [dto] = await this.toSetlistDtos(manager, [setlist]);
    if (!dto) {
      throw vjError('VJ_SETLIST_NOT_FOUND');
    }
    return dto;
  }

  /** Set list DTOs in the order given, items read in one query and creators
   *  in one more. */
  private async toSetlistDtos(
    manager: EntityManager,
    setlists: VjSetlist[],
  ): Promise<VjSetlistDTO[]> {
    if (setlists.length === 0) {
      return [];
    }
    const items = await manager.find(VjSetlistItem, {
      where: { setlistId: In(setlists.map((setlist) => setlist.id)) },
      select: {
        id: true,
        setlistId: true,
        position: true,
        kind: true,
        sceneId: true,
        clipId: true,
        durationKind: true,
        durationValue: true,
      },
      order: { position: 'ASC', id: 'ASC' },
    });
    const itemsBySetlist = new Map<string, VjSetlistItemRow[]>();
    for (const item of items) {
      const setlistItems = itemsBySetlist.get(item.setlistId) ?? [];
      setlistItems.push(item);
      itemsBySetlist.set(item.setlistId, setlistItems);
    }
    const profiles = await readVjCreatorProfiles(
      manager,
      setlists.map((setlist) => setlist.createdByUserId),
    );
    return setlists.map((setlist) =>
      toVjSetlist(setlist, itemsBySetlist.get(setlist.id) ?? [], profiles),
    );
  }

  /** Announces a committed library write to the `/vj` gateway. */
  private emitChange(change: VjLibraryChange): void {
    this.eventEmitter.emit(VJ_LIBRARY_CHANGED, change);
  }
}

/** The create's `sceneIds` as scene steps on the sequence default length. */
function sceneStepEntries(sceneIds: readonly string[]): VjSetlistItemEntry[] {
  return sceneIds.map((sceneId) => ({
    id: null,
    kind: 'scene',
    sceneId,
    clipId: null,
    duration: null,
  }));
}

/** The scene ids of the scene steps, in list order, repeats kept. */
function entrySceneIds(entries: readonly VjSetlistItemEntry[]): string[] {
  return entries
    .map((entry) => entry.sceneId)
    .filter((sceneId): sceneId is string => sceneId !== null);
}

/** The clip ids of the clip steps, in list order, repeats kept. */
function entryClipIds(entries: readonly VjSetlistItemEntry[]): string[] {
  return entries
    .map((entry) => entry.clipId)
    .filter((clipId): clipId is string => clipId !== null);
}

/** The row columns one entry writes at `position`. */
function itemColumnsOf(
  entry: VjSetlistItemEntry,
  position: number,
): VjSetlistItemColumns {
  return {
    kind: entry.kind,
    sceneId: entry.sceneId,
    clipId: entry.clipId,
    durationKind: entry.duration === null ? null : entry.duration.kind,
    durationValue: entry.duration === null ? null : entry.duration.value,
    position,
  };
}

/** Whether a stored row already holds every column `columns` writes. */
function isSameItemColumns(
  stored: VjStoredSetlistItem,
  columns: VjSetlistItemColumns,
): boolean {
  return (
    stored.kind === columns.kind &&
    stored.sceneId === columns.sceneId &&
    stored.clipId === columns.clipId &&
    stored.durationKind === columns.durationKind &&
    stored.durationValue === columns.durationValue &&
    stored.position === columns.position
  );
}

/** Contract 4.4's no-op test: the same ids in the same order, no id-less
 *  entry, and every kind, target and length equal. */
function isStoredStepList(
  storedItems: readonly VjStoredSetlistItem[],
  entries: readonly VjSetlistItemEntry[],
): boolean {
  return (
    storedItems.length === entries.length &&
    entries.every((entry, index) => {
      const stored = storedItems[index];
      if (stored === undefined || entry.id !== stored.id) {
        return false;
      }
      const columns = itemColumnsOf(entry, stored.position);
      return isSameItemColumns(stored, columns);
    })
  );
}

/** A PATCH body's field rules, in contract 4.4 order: no field defined
 *  (`VJ_SETLIST_PATCH_EMPTY`), `name`, `isLooping`, `stepDuration`. */
function readUpdateFields(body: UpdateVjSetlistDto): VjSetlistUpdateFields {
  if (
    body.name === undefined &&
    body.isLooping === undefined &&
    body.stepDuration === undefined
  ) {
    throw vjError('VJ_SETLIST_PATCH_EMPTY');
  }
  const fields: VjSetlistUpdateFields = {};
  if (body.name !== undefined) {
    fields.name = normalizeSetlistName(body.name);
  }
  if (body.isLooping !== undefined) {
    fields.isLooping = normalizeSetlistLooping(body.isLooping);
  }
  if (body.stepDuration !== undefined) {
    fields.stepDuration = normalizeStepDuration(body.stepDuration);
  }
  return fields;
}

/** The columns whose stored value differs from the PATCH; empty when every
 *  field equals the stored one. The length writes kind and value together. */
function changedSetlistColumns(
  stored: Pick<
    VjSetlist,
    'name' | 'isLooping' | 'stepDurationKind' | 'stepDurationValue'
  >,
  fields: VjSetlistUpdateFields,
): VjSetlistUpdateColumns {
  const columns: VjSetlistUpdateColumns = {};
  if (fields.name !== undefined && fields.name !== stored.name) {
    columns.name = fields.name;
  }
  if (fields.isLooping !== undefined && fields.isLooping !== stored.isLooping) {
    columns.isLooping = fields.isLooping;
  }
  if (
    fields.stepDuration !== undefined &&
    (fields.stepDuration.kind !== stored.stepDurationKind ||
      fields.stepDuration.value !== Number(stored.stepDurationValue))
  ) {
    columns.stepDurationKind = fields.stepDuration.kind;
    columns.stepDurationValue = fields.stepDuration.value;
  }
  return columns;
}

/** The first id of `sceneIds`, in list order, that no scene row holds
 *  answers `VJ_SCENE_NOT_FOUND` with that `sceneId`. */
function assertScenesFound(
  sceneIds: readonly string[],
  foundSceneIds: ReadonlySet<string>,
): void {
  const missingSceneId = sceneIds.find(
    (sceneId) => !foundSceneIds.has(sceneId),
  );
  if (missingSceneId !== undefined) {
    throw vjError('VJ_SCENE_NOT_FOUND', { sceneId: missingSceneId });
  }
}

/** The first id of `clipIds`, in list order, that no clip row holds answers
 *  `VJ_CLIP_NOT_FOUND` with that `clipId`. */
function assertClipsFound(
  clipIds: readonly string[],
  foundClipIds: ReadonlySet<string>,
): void {
  const missingClipId = clipIds.find((clipId) => !foundClipIds.has(clipId));
  if (missingClipId !== undefined) {
    throw vjError('VJ_CLIP_NOT_FOUND', { clipId: missingClipId });
  }
}
