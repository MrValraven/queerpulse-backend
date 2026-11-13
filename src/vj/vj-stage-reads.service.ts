import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { normalizeStoredVjSceneLook } from './vj-scene-look';
import { isUuidText } from './vj-input';
import {
  DEFAULT_VJ_STEP_DURATION,
  VJ_LIMITS,
  isVjStepDuration,
  vjResolvedStepDuration,
  vjSetlistIndexPosition,
  type VjSceneLook,
  type VjSetlistFollowRead,
  type VjSetlistRead,
  type VjSetlistReadPosition,
  type VjSetlistStepRead,
  type VjStepDuration,
} from './vj.contract';

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

/** `$1` set list id, `$2` step index or null, `$3` `'first'`, `'last'` or
 *  `'none'` (sequences 5.8). One row per set list: its Loop, its default step
 *  length, every item id in play order (position, id), and the step at the
 *  asked position with its 0-based index, kind, targets, own length and the
 *  scene's look. The step reads `$2` while it is below the item count, step
 *  0 past the end when `$3` is `'first'`, the final step when `$3` is
 *  `'last'`, and no step for a null `$2` or past the end otherwise (its
 *  columns null). No row when no set list has the id. */
export const VJ_STAGE_SETLIST_READ_SQL = `SELECT "setlist"."is_looping", "setlist"."step_duration_kind", "setlist"."step_duration_value",
  (SELECT COALESCE(array_agg("listed_item"."id"::text ORDER BY "listed_item"."position", "listed_item"."id"), ARRAY[]::text[]) FROM "vj_setlist_items" "listed_item" WHERE "listed_item"."setlist_id" = "setlist"."id") AS "item_ids",
  "item"."id" AS "item_id", "item"."item_index", "item"."kind", "item"."scene_id", "item"."clip_id", "item"."duration_kind", "item"."duration_value", "scene"."look"
FROM "vj_setlists" "setlist"
LEFT JOIN LATERAL (
  SELECT "ranked"."id", "ranked"."item_index", "ranked"."kind", "ranked"."scene_id", "ranked"."clip_id", "ranked"."duration_kind", "ranked"."duration_value"
  FROM (SELECT "indexed_item".*, (ROW_NUMBER() OVER (ORDER BY "indexed_item"."position", "indexed_item"."id") - 1)::int AS "item_index", (COUNT(*) OVER ())::int AS "item_count" FROM "vj_setlist_items" "indexed_item" WHERE "indexed_item"."setlist_id" = "setlist"."id") "ranked"
  WHERE "ranked"."item_index" = CASE WHEN $3::text = 'last' THEN "ranked"."item_count" - 1 WHEN $2::int IS NULL THEN -1 WHEN $2::int < "ranked"."item_count" THEN $2::int WHEN $3::text = 'first' THEN 0 ELSE -1 END
) "item" ON true
LEFT JOIN "vj_scenes" "scene" ON "scene"."id" = "item"."scene_id"
WHERE "setlist"."id" = $1::uuid`;

/** `$1` set list id. The set list's Loop and every item id in play order
 *  (position, id), for a library change on the stage (sequences 7); no row
 *  when no set list has the id. */
export const VJ_STAGE_SETLIST_FOLLOW_SQL = `SELECT "setlist"."is_looping",
  (SELECT COALESCE(array_agg("item"."id"::text ORDER BY "item"."position", "item"."id"), ARRAY[]::text[]) FROM "vj_setlist_items" "item" WHERE "item"."setlist_id" = "setlist"."id") AS "item_ids"
FROM "vj_setlists" "setlist" WHERE "setlist"."id" = $1::uuid`;

/** The `$3` mode of `VJ_STAGE_SETLIST_READ_SQL`. */
type VjSetlistReadMode = 'first' | 'last' | 'none';

/** One row of `VJ_STAGE_SETLIST_FOLLOW_SQL` as the driver hands it back. */
interface VjStageSetlistFollowRawRow {
  is_looping: unknown;
  item_ids: unknown;
}

/** One row of `VJ_STAGE_SETLIST_READ_SQL` as the driver hands it back; the
 *  step columns are null when the position holds no step. */
interface VjStageSetlistReadRawRow extends VjStageSetlistFollowRawRow {
  step_duration_kind: unknown;
  step_duration_value: unknown;
  item_id: string | null;
  item_index: number | string | null;
  kind: unknown;
  scene_id: string | null;
  clip_id: string | null;
  duration_kind: unknown;
  duration_value: unknown;
  look: unknown;
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

/** Whether a set list index is one the step read can ask for: a whole
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

/** The `$2` and `$3` parameters of a read position (sequences 5.8): `count`
 *  gives null and `'none'`, `index` its index and `'first'` or `'none'`,
 *  `last` null and `'last'`. An index at or past setlistItemsMax is
 *  normalised by `vjSetlistIndexPosition` first; one that is no whole number
 *  at or above 0 reads as `count`, so `$2::int` always fits. */
function vjSetlistReadParameters(
  position: VjSetlistReadPosition,
): [number | null, VjSetlistReadMode] {
  if (position.kind === 'count') {
    return [null, 'none'];
  }
  if (position.kind === 'last') {
    return [null, 'last'];
  }
  const isWholeIndex =
    Number.isSafeInteger(position.index) && position.index >= 0;
  if (!isWholeIndex) {
    return [null, 'none'];
  }
  const normalised = isItemIndex(position.index)
    ? position
    : vjSetlistIndexPosition(position.index, position.wrapsToFirst);
  if (normalised.kind !== 'index') {
    return [null, 'none'];
  }
  return [normalised.index, normalised.wrapsToFirst ? 'first' : 'none'];
}

/** A stored integer column as a number; null when it holds none. */
function storedInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** A stored kind and value pair as a step length; null when it is no step
 *  length in range (both columns null included). */
function storedVjStepDuration(
  kind: unknown,
  value: unknown,
): VjStepDuration | null {
  const duration = { kind, value: storedInteger(value) };
  return isVjStepDuration(duration) ? duration : null;
}

/** The stored item ids, lowercased, in the order the read gave them. */
function storedItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((itemId): itemId is string => typeof itemId === 'string')
    .map((itemId) => itemId.toLowerCase());
}

/** The step a read row holds, its length resolved against the sequence
 *  default; null when the row holds no step, or a step whose kind and
 *  target do not match (the table CHECK rules that out). */
function storedVjSetlistStep(
  row: VjStageSetlistReadRawRow,
  sequenceDefault: VjStepDuration,
): VjSetlistStepRead | null {
  const index = storedInteger(row.item_index);
  if (row.item_id === null || index === null) {
    return null;
  }
  const itemId = row.item_id.toLowerCase();
  const duration = vjResolvedStepDuration(
    storedVjStepDuration(row.duration_kind, row.duration_value),
    sequenceDefault,
  );
  if (row.kind === 'scene' && row.scene_id !== null) {
    return {
      kind: 'scene',
      itemId,
      index,
      sceneId: row.scene_id.toLowerCase(),
      look: normalizeStoredVjSceneLook(row.look),
      duration,
    };
  }
  if (row.kind === 'clip' && row.clip_id !== null) {
    return {
      kind: 'clip',
      itemId,
      index,
      clipId: row.clip_id.toLowerCase(),
      duration,
    };
  }
  return null;
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

  /** Set list commands, the step timer and the restore (sequences 5.8): one
   *  read answering Loop, the default step length, every item id in play
   *  order and the step at the position (null for `count` and past the
   *  end). Null when no set list has the id; a malformed id answers null
   *  with no query. A stored step length outside the bounds reads as the
   *  sequence default, and a bad sequence default as
   *  `DEFAULT_VJ_STEP_DURATION`. */
  async readSetlist(
    setlistId: string,
    position: VjSetlistReadPosition,
  ): Promise<VjSetlistRead | null> {
    if (!isUuidText(setlistId)) {
      return null;
    }
    const lowercaseSetlistId = setlistId.toLowerCase();
    const [index, mode] = vjSetlistReadParameters(position);
    const rows: VjStageSetlistReadRawRow[] = await this.dataSource.query(
      VJ_STAGE_SETLIST_READ_SQL,
      [lowercaseSetlistId, index, mode],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const stepDuration =
      storedVjStepDuration(row.step_duration_kind, row.step_duration_value) ??
      DEFAULT_VJ_STEP_DURATION;
    return {
      setlistId: lowercaseSetlistId,
      isLooping: row.is_looping === true,
      stepDuration,
      itemIds: storedItemIds(row.item_ids),
      step: storedVjSetlistStep(row, stepDuration),
    };
  }

  /** Library changes on the stage (sequences 7): the set list's Loop and
   *  every item id in play order, or null when no set list has the id. A
   *  malformed id answers null with no query. */
  async readSetlistFollow(
    setlistId: string,
  ): Promise<VjSetlistFollowRead | null> {
    if (!isUuidText(setlistId)) {
      return null;
    }
    const rows: VjStageSetlistFollowRawRow[] = await this.dataSource.query(
      VJ_STAGE_SETLIST_FOLLOW_SQL,
      [setlistId.toLowerCase()],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      itemIds: storedItemIds(row.item_ids),
      isLooping: row.is_looping === true,
    };
  }
}
