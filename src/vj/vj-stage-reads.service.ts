import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { normalizeStoredVjSceneLook } from './vj-scene-look';
import { isUuidText } from './vj-input';
import { VJ_LIMITS, type VjSceneLook } from './vj.contract';

/**
 * The socket's existence reads (contract 7.7, plan note 1). The gateway
 * resolves a command's lookups through these before the stage service
 * reruns its rules. Each method is one indexed read; a malformed id answers
 * the empty answer with no query. Nothing here writes or logs.
 */

/** `$1` pack id. The pack's linked event id; no row when no pack has the id. */
export const VJ_STAGE_PACK_SQL = `SELECT "pack"."event_id" FROM "vj_packs" "pack" WHERE "pack"."id" = $1::uuid`;

/** `$1` clip ids. One row per id a clip has. */
export const VJ_STAGE_EXISTING_CLIPS_SQL = `SELECT "clip"."id" FROM "vj_clips" "clip" WHERE "clip"."id" = ANY($1::uuid[])`;

/** `$1` pack id, `$2` clip ids. One row per listed clip the pack holds. */
export const VJ_STAGE_CLIPS_IN_PACK_SQL = `SELECT "pack_clip"."clip_id" FROM "vj_pack_clips" "pack_clip" WHERE "pack_clip"."pack_id" = $1::uuid AND "pack_clip"."clip_id" = ANY($2::uuid[])`;

/** `$1` pack id, `$2` clip id. The clip's favorite flag when the pack holds
 *  it; no row otherwise. */
export const VJ_STAGE_PACK_CLIP_SQL = `SELECT "clip"."is_favorite" FROM "vj_pack_clips" "pack_clip" JOIN "vj_clips" "clip" ON "clip"."id" = "pack_clip"."clip_id" WHERE "pack_clip"."pack_id" = $1::uuid AND "pack_clip"."clip_id" = $2::uuid`;

/** `$1` scene id. The stored look; no row when no scene has the id. */
export const VJ_STAGE_SCENE_LOOK_SQL = `SELECT "scene"."look" FROM "vj_scenes" "scene" WHERE "scene"."id" = $1::uuid`;

/** `$1` set list id. The set list's item count; no row when no set list has
 *  the id. */
export const VJ_STAGE_SETLIST_COUNT_SQL = `SELECT (SELECT COUNT(*)::int FROM "vj_setlist_items" "counted_item" WHERE "counted_item"."setlist_id" = "setlist"."id") AS "item_count"
FROM "vj_setlists" "setlist"
WHERE "setlist"."id" = $1::uuid`;

/** `$1` set list id, `$2` item index. The set list's item count and the item
 *  at `ORDER BY position, id OFFSET $2` with its scene's look (both null past
 *  the last item); no row when no set list has the id. */
export const VJ_STAGE_SETLIST_ITEM_SQL = `SELECT (SELECT COUNT(*)::int FROM "vj_setlist_items" "counted_item" WHERE "counted_item"."setlist_id" = "setlist"."id") AS "item_count",
  "item"."scene_id", "scene"."look"
FROM "vj_setlists" "setlist"
LEFT JOIN LATERAL (SELECT "indexed_item"."scene_id" FROM "vj_setlist_items" "indexed_item" WHERE "indexed_item"."setlist_id" = "setlist"."id" ORDER BY "indexed_item"."position", "indexed_item"."id" OFFSET $2::int LIMIT 1) "item" ON true
LEFT JOIN "vj_scenes" "scene" ON "scene"."id" = "item"."scene_id"
WHERE "setlist"."id" = $1::uuid`;

/** A set list read: the item count, and the item at the asked index with its
 *  scene's look (null for a count-only read or past the last item). */
export interface VjStageSetlistItemAnswer {
  itemCount: number;
  sceneId: string | null;
  look: VjSceneLook | null;
}

/** One row of `VJ_STAGE_SETLIST_ITEM_SQL` as the driver hands it back. */
interface VjStageSetlistItemRawRow {
  item_count: number | string;
  scene_id?: string | null;
  look?: unknown;
}

/** The valid ids of a list, lowercased, each once. */
function lowercaseUniqueUuids(ids: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (isUuidText(id)) {
      unique.add(id.toLowerCase());
    }
  }
  return [...unique];
}

/** Whether a set list index is one the item read can offset by: a whole
 *  number below setlistItemsMax, so `$2::int` always fits Postgres. No set
 *  list holds an item at a larger index. */
function isItemIndex(index: unknown): index is number {
  return (
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < VJ_LIMITS.setlistItemsMax
  );
}

/** The contract 7.7 reads, kept off `VjLibraryService` (plan note 1). */
@Injectable()
export class VjStageReadsService {
  constructor(private readonly dataSource: DataSource) {}

  /** `stage:setPack` and `stage:setEventCard`: the pack's linked event id, or
   *  null when no pack has the id. */
  async readPackForStage(
    packId: string,
  ): Promise<{ eventId: string | null } | null> {
    if (!isUuidText(packId)) {
      return null;
    }
    const rows: { event_id: string | null }[] = await this.dataSource.query(
      VJ_STAGE_PACK_SQL,
      [packId.toLowerCase()],
    );
    const row = rows[0];
    return row === undefined ? null : { eventId: row.event_id ?? null };
  }

  /** The listed ids a clip has, lowercased. Malformed ids are left out; no
   *  valid id answers an empty set with no query. */
  async existingClipIds(clipIds: string[]): Promise<Set<string>> {
    const validIds = lowercaseUniqueUuids(clipIds);
    if (validIds.length === 0) {
      return new Set<string>();
    }
    const rows: { id: string }[] = await this.dataSource.query(
      VJ_STAGE_EXISTING_CLIPS_SQL,
      [validIds],
    );
    return new Set(rows.map((row) => row.id.toLowerCase()));
  }

  /** The listed clip ids the pack holds, lowercased. A malformed pack id or
   *  no valid clip id answers an empty set with no query. */
  async clipIdsInPack(packId: string, clipIds: string[]): Promise<Set<string>> {
    const validIds = lowercaseUniqueUuids(clipIds);
    if (!isUuidText(packId) || validIds.length === 0) {
      return new Set<string>();
    }
    const rows: { clip_id: string }[] = await this.dataSource.query(
      VJ_STAGE_CLIPS_IN_PACK_SQL,
      [packId.toLowerCase(), validIds],
    );
    return new Set(rows.map((row) => row.clip_id.toLowerCase()));
  }

  /** `screen:advance`: the clip's favorite flag when the pack holds it, or
   *  null when it does not. */
  async readPackClipForAdvance(
    packId: string,
    clipId: string,
  ): Promise<{ isFavorite: boolean } | null> {
    if (!isUuidText(packId) || !isUuidText(clipId)) {
      return null;
    }
    const rows: { is_favorite: boolean }[] = await this.dataSource.query(
      VJ_STAGE_PACK_CLIP_SQL,
      [packId.toLowerCase(), clipId.toLowerCase()],
    );
    const row = rows[0];
    return row === undefined ? null : { isFavorite: row.is_favorite === true };
  }

  /** `stage:recallScene`: the scene's stored look through the lenient
   *  normaliser, or null when no scene has the id. */
  async readSceneLook(sceneId: string): Promise<VjSceneLook | null> {
    if (!isUuidText(sceneId)) {
      return null;
    }
    const rows: { look: unknown }[] = await this.dataSource.query(
      VJ_STAGE_SCENE_LOOK_SQL,
      [sceneId.toLowerCase()],
    );
    const row = rows[0];
    return row === undefined ? null : normalizeStoredVjSceneLook(row.look);
  }

  /** Set list recall and steps: null when no set list has the id. A null
   *  index answers the count with `sceneId` and `look` null; an index answers
   *  the item at `ORDER BY position, id OFFSET index` with its scene's look
   *  (both null past the last item). An index that is no whole number in
   *  `0..setlistItemsMax - 1` reads as a count-only read. */
  async readSetlistItem(
    setlistId: string,
    index: number | null,
  ): Promise<VjStageSetlistItemAnswer | null> {
    if (!isUuidText(setlistId)) {
      return null;
    }
    const lowercaseSetlistId = setlistId.toLowerCase();
    const rows: VjStageSetlistItemRawRow[] = isItemIndex(index)
      ? await this.dataSource.query(VJ_STAGE_SETLIST_ITEM_SQL, [
          lowercaseSetlistId,
          index,
        ])
      : await this.dataSource.query(VJ_STAGE_SETLIST_COUNT_SQL, [
          lowercaseSetlistId,
        ]);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const sceneId = row.scene_id ?? null;
    return {
      itemCount: Number(row.item_count),
      sceneId: sceneId === null ? null : sceneId.toLowerCase(),
      look: sceneId === null ? null : normalizeStoredVjSceneLook(row.look),
    };
  }

  /** Library changes: the set list's item count, or null when no set list
   *  has the id. */
  async setlistItemCount(setlistId: string): Promise<number | null> {
    if (!isUuidText(setlistId)) {
      return null;
    }
    const rows: { item_count: number | string }[] = await this.dataSource.query(
      VJ_STAGE_SETLIST_COUNT_SQL,
      [setlistId.toLowerCase()],
    );
    const row = rows[0];
    return row === undefined ? null : Number(row.item_count);
  }
}
