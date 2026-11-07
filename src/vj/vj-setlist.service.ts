import { HttpException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import type {
  CreateVjSetlistDto,
  RenameVjSetlistDto,
  ReorderVjSetlistsDto,
  SetVjSetlistItemsDto,
} from './dto/vj.dto';
import { VjSetlistItem } from './entities/vj-setlist-item.entity';
import { VjSetlist } from './entities/vj-setlist.entity';
import {
  normalizeIdPermutation,
  normalizeSetlistName,
  normalizeSetlistSceneIds,
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
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
} from './vj.contract';

/** Set list create, rename, reorder, item replace and delete take this, so
 *  the 50 cap, the case-insensitive name check and the dense positions hold
 *  under two admins writing at once. The item replace takes it before the
 *  set list row, so its `updated_at` bump never waits on a delete that holds
 *  the table and waits on the row. */
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

/** `$1` set list id. Bumps `updated_at` after an item replace, which writes
 *  no set list column itself. */
export const TOUCH_VJ_SETLIST_SQL = `UPDATE "vj_setlists" SET "updated_at" = now() WHERE "id" = $1`;

/** An item insert naming a scene a delete removed answers
 *  `VJ_SCENE_NOT_FOUND`. The violation carries no readable scene id, so the
 *  refusal names none. */
const SETLIST_REFUSALS: VjTransactionRefusals = {
  onForeignKey: new Map<string, () => HttpException>([
    ['FK_vj_setlist_items_scene', () => vjError('VJ_SCENE_NOT_FOUND')],
  ]),
};

/**
 * VJ set lists behind `admin/vj/setlists`: named, ordered runs of scenes a
 * remote steps through. Names are unique ignoring case; set list positions
 * and item positions stay dense (`0..n-1`); a scene may sit in one set list
 * more than once. Field rules run before any read, in the contract's check
 * order. Named scenes are read `FOR SHARE` before any set list lock. Every
 * write emits `VJ_LIBRARY_CHANGED` after its transaction commits. Nothing
 * logs a set list name.
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

  /** Appends a set list with its items at `0..n-1`. Name and items are
   *  checked before the transaction; the cap, the name clash and the scene
   *  ids run under the table lock. */
  async createSetlist(
    caller: VjCaller,
    body: CreateVjSetlistDto,
  ): Promise<VjSetlistDTO> {
    const name = normalizeSetlistName(body.name);
    const sceneIds = normalizeSetlistSceneIds(
      body.sceneIds === undefined ? [] : body.sceneIds,
      null,
    );
    const setlistId = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const foundSceneIds = await this.shareScenes(manager, sceneIds);
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlistCount = await manager.count(VjSetlist);
        if (setlistCount >= VJ_LIMITS.setlistsMax) {
          throw vjError('VJ_SETLIST_LIMIT_REACHED');
        }
        await this.assertNameFree(manager, name, null);
        assertScenesFound(sceneIds, foundSceneIds);
        const setlist = manager.create(VjSetlist, {
          name,
          position: setlistCount,
          createdByUserId: caller.userId,
        });
        const saved = await manager.save(VjSetlist, setlist);
        await this.insertItems(manager, saved.id, sceneIds);
        return saved.id;
      },
      SETLIST_REFUSALS,
    );
    this.emitChange(buildVjLibraryChange('setlist_created', { setlistId }));
    return this.readSetlist(setlistId);
  }

  /** Renames a set list. The stored name (same case) is a no-op with no
   *  write and no event; a case-only change is a rename. */
  async renameSetlist(
    requestedSetlistId: string,
    body: RenameVjSetlistDto,
  ): Promise<VjSetlistDTO> {
    const setlistId = lowercaseIdOrRefuse(
      requestedSetlistId,
      'VJ_SETLIST_NOT_FOUND',
    );
    const name = normalizeSetlistName(body.name);
    const isRenamed = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        const setlist = await manager.findOne(VjSetlist, {
          where: { id: setlistId },
          select: { id: true, name: true },
        });
        if (!setlist) {
          throw vjError('VJ_SETLIST_NOT_FOUND');
        }
        if (setlist.name === name) {
          return false;
        }
        await this.assertNameFree(manager, name, setlistId);
        await manager.update(VjSetlist, { id: setlistId }, { name });
        return true;
      },
      SETLIST_REFUSALS,
    );
    if (isRenamed) {
      this.emitChange(buildVjLibraryChange('setlist_renamed', { setlistId }));
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

  /** Replaces every item of a set list with `sceneIds` at `0..n-1`, repeats
   *  kept, and bumps `updated_at`. Scenes are read `FOR SHARE` before the
   *  table lock and the set list row. The stored scene ids in the same
   *  order write nothing and emit nothing. */
  async setSetlistItems(
    requestedSetlistId: string,
    body: SetVjSetlistItemsDto,
  ): Promise<VjSetlistDTO> {
    const setlistId = lowercaseIdOrRefuse(
      requestedSetlistId,
      'VJ_SETLIST_NOT_FOUND',
    );
    const sceneIds = normalizeSetlistSceneIds(body.sceneIds, setlistId);
    const isChanged = await runVjTransaction(
      this.dataSource,
      async (manager) => {
        const foundSceneIds = await this.shareScenes(manager, sceneIds);
        await manager.query(LOCK_VJ_SETLISTS_SQL);
        await this.lockSetlist(manager, setlistId);
        assertScenesFound(sceneIds, foundSceneIds);
        if (await this.isStoredSceneOrder(manager, setlistId, sceneIds)) {
          return false;
        }
        await manager.delete(VjSetlistItem, { setlistId });
        await this.insertItems(manager, setlistId, sceneIds);
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

  /** Reads the named scenes `FOR SHARE` and answers the ids that exist. No
   *  read for an empty list. */
  private async shareScenes(
    manager: EntityManager,
    sceneIds: readonly string[],
  ): Promise<Set<string>> {
    if (sceneIds.length === 0) {
      return new Set();
    }
    const uniqueIds = [...new Set(sceneIds)];
    const rows: { id: string }[] = await manager.query(
      VJ_SCENES_FOR_SHARE_SQL,
      [uniqueIds],
    );
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

  /** Whether the set list's stored items name `sceneIds` in the same order,
   *  read under the set list row lock. */
  private async isStoredSceneOrder(
    manager: EntityManager,
    setlistId: string,
    sceneIds: readonly string[],
  ): Promise<boolean> {
    const storedItems = await manager.find(VjSetlistItem, {
      where: { setlistId },
      select: { id: true, sceneId: true, position: true },
      order: { position: 'ASC', id: 'ASC' },
    });
    return (
      storedItems.length === sceneIds.length &&
      storedItems.every(
        (item, position) => item.sceneId.toLowerCase() === sceneIds[position],
      )
    );
  }

  /** Inserts the items at positions `0..n-1`; nothing for an empty list. */
  private async insertItems(
    manager: EntityManager,
    setlistId: string,
    sceneIds: readonly string[],
  ): Promise<void> {
    if (sceneIds.length === 0) {
      return;
    }
    await manager.insert(
      VjSetlistItem,
      sceneIds.map((sceneId, position) => ({ setlistId, sceneId, position })),
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
      select: { id: true, setlistId: true, sceneId: true, position: true },
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
