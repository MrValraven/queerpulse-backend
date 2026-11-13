/**
 * Field rules of the VJ routes, as pure functions.
 *
 * The service runs these before any query, so a CHECK violation never reaches
 * the driver with a title in its text. Each function answers the contract's
 * reason code through `vjError`, in the contract's check order, and no message
 * carries the value it refused.
 */
import { isUUID } from 'class-validator';
import type { CreateVjClipDto, UpdateVjClipDto } from './dto/vj.dto';
import {
  isVjClipKey,
  isVjThumbnailKey,
  vjClipContentTypeForKey,
} from '../storage/storage-key';
import { vjError, type VjRefusalCode } from './vj.constants';
import {
  DEFAULT_VJ_FIT_MODE,
  isVjStepDuration,
  VJ_FIT_MODES,
  VJ_LIMITS,
  VJ_LOOP_MODES,
  VJ_SETLIST_ITEM_KINDS,
  VJ_SPEEDS,
  type VjClipMimeType,
  type VjFitMode,
  type VjLoopMode,
  type VjMediaKind,
  type VjSetlistItemKind,
  type VjSpeed,
  type VjStepDuration,
} from './vj.contract';

/** How many code points a string holds, so an emoji counts once. */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

/** Trims a text value and checks it against the required and maximum codes. */
function normalizeBoundedText(
  value: unknown,
  maxCodePoints: number,
  requiredCode: VjRefusalCode,
  tooLongCode: VjRefusalCode,
): string {
  if (typeof value !== 'string') {
    throw vjError(requiredCode);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw vjError(requiredCode);
  }
  if (countCodePoints(trimmed) > maxCodePoints) {
    throw vjError(tooLongCode);
  }
  return trimmed;
}

/** A pack name, trimmed. Answers `VJ_PACK_NAME_REQUIRED` or
 *  `VJ_PACK_NAME_TOO_LONG`. */
export function normalizePackName(value: unknown): string {
  return normalizeBoundedText(
    value,
    VJ_LIMITS.packNameMax,
    'VJ_PACK_NAME_REQUIRED',
    'VJ_PACK_NAME_TOO_LONG',
  );
}

/** A clip title, trimmed. Answers `VJ_CLIP_TITLE_REQUIRED` or
 *  `VJ_CLIP_TITLE_TOO_LONG`. */
export function normalizeClipTitle(value: unknown): string {
  return normalizeBoundedText(
    value,
    VJ_LIMITS.clipTitleMax,
    'VJ_CLIP_TITLE_REQUIRED',
    'VJ_CLIP_TITLE_TOO_LONG',
  );
}

/** A fit mode. Answers `VJ_CLIP_FIT_MODE_INVALID` for anything but a listed
 *  mode. */
export function normalizeFitMode(value: unknown): VjFitMode {
  const fitMode = VJ_FIT_MODES.find((candidate) => candidate === value);
  if (fitMode === undefined) {
    throw vjError('VJ_CLIP_FIT_MODE_INVALID');
  }
  return fitMode;
}

/** Whether a value is a whole number of pixels from 1 to the dimension cap. */
export function isVjDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= VJ_LIMITS.dimensionMax
  );
}

/** A clip duration for its kind: a whole number of milliseconds from 1 to one
 *  hour for a video, nothing for a GIF (an absent value counts as null).
 *  Answers `VJ_CLIP_DURATION_INVALID`. */
export function normalizeDurationMs(
  mediaKind: VjMediaKind,
  value: unknown,
): number | null {
  if (mediaKind === 'gif') {
    if (value === undefined || value === null) {
      return null;
    }
    throw vjError('VJ_CLIP_DURATION_INVALID');
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > VJ_LIMITS.durationMsMax
  ) {
    throw vjError('VJ_CLIP_DURATION_INVALID');
  }
  return value;
}

/** Whether a value is text in the shape of a uuid. */
export function isUuidText(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/** Checks a reorder list as a permutation of the ids the service just read,
 *  and answers it lowercased. Answers the given code for a non-list, a
 *  non-text entry, a repeat, a missing id or an unknown id. */
export function normalizeIdPermutation(
  value: unknown,
  expectedIds: readonly string[],
  code:
    | 'VJ_PACK_REORDER_MISMATCH'
    | 'VJ_PACK_CLIPS_REORDER_MISMATCH'
    | 'VJ_SCENE_REORDER_MISMATCH'
    | 'VJ_SETLIST_REORDER_MISMATCH',
): string[] {
  if (!Array.isArray(value) || value.length !== expectedIds.length) {
    throw vjError(code);
  }
  const expectedSet = new Set(expectedIds.map((id) => id.toLowerCase()));
  const seenIds = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      throw vjError(code);
    }
    const lowered = entry.toLowerCase();
    if (!expectedSet.has(lowered) || seenIds.has(lowered)) {
      throw vjError(code);
    }
    seenIds.add(lowered);
  }
  return Array.from(seenIds);
}

/** Reads the `clipIds` query: absent gives null (every clip of the pack),
 *  otherwise 1 to 200 comma-separated uuids, lowercased and deduplicated.
 *  Answers `VJ_CLIP_IDS_INVALID`. */
export function parseMediaClipIds(value: unknown): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw vjError('VJ_CLIP_IDS_INVALID');
  }
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length < 1 || parts.length > VJ_LIMITS.mediaClipIdsMax) {
    throw vjError('VJ_CLIP_IDS_INVALID');
  }
  const clipIds = new Set<string>();
  for (const part of parts) {
    if (!isUuidText(part)) {
      throw vjError('VJ_CLIP_IDS_INVALID');
    }
    clipIds.add(part.toLowerCase());
  }
  return Array.from(clipIds);
}

/** A clip create body after steps 1 to 7 of contract 5.3. */
export interface NormalizedVjClipCreate {
  title: string;
  storageKey: string;
  thumbnailStorageKey: string;
  mimeType: VjClipMimeType;
  mediaKind: VjMediaKind;
  width: number;
  height: number;
  durationMs: number | null;
  fitMode: VjFitMode;
  packId: string | null;
}

/** Runs contract 5.3 steps 1 to 7 in order and answers the first failure's
 *  code: title, clip key, thumbnail key, dimensions, duration, fit mode, pack
 *  id. The type and kind come from the clip key's extension. */
export function normalizeClipCreate(
  body: CreateVjClipDto,
): NormalizedVjClipCreate {
  const title = normalizeClipTitle(body.title);
  const storageKey = body.storageKey;
  if (typeof storageKey !== 'string' || !isVjClipKey(storageKey)) {
    throw vjError('VJ_CLIP_KEY_INVALID', { field: 'storageKey' });
  }
  const thumbnailStorageKey = body.thumbnailStorageKey;
  if (
    typeof thumbnailStorageKey !== 'string' ||
    !isVjThumbnailKey(thumbnailStorageKey)
  ) {
    throw vjError('VJ_CLIP_KEY_INVALID', { field: 'thumbnailStorageKey' });
  }
  const mimeType = vjClipContentTypeForKey(storageKey);
  if (mimeType === null) {
    throw vjError('VJ_CLIP_KEY_INVALID', { field: 'storageKey' });
  }
  const mediaKind: VjMediaKind = mimeType === 'image/gif' ? 'gif' : 'video';
  if (!isVjDimension(body.width) || !isVjDimension(body.height)) {
    throw vjError('VJ_CLIP_DIMENSIONS_INVALID');
  }
  const durationMs = normalizeDurationMs(mediaKind, body.durationMs);
  const fitMode =
    body.fitMode === undefined
      ? DEFAULT_VJ_FIT_MODE
      : normalizeFitMode(body.fitMode);
  let packId: string | null = null;
  if (body.packId !== undefined && body.packId !== null) {
    if (!isUuidText(body.packId)) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    packId = body.packId.toLowerCase();
  }
  return {
    title,
    storageKey,
    thumbnailStorageKey,
    mimeType,
    mediaKind,
    width: body.width,
    height: body.height,
    durationMs,
    fitMode,
    packId,
  };
}

/** A clip update after steps 2 to 7 of contract 6.3. An absent property is
 *  left out; a loop point may be null, which clears it. */
export interface NormalizedVjClipUpdate {
  title?: string;
  fitMode?: VjFitMode;
  isFavorite?: boolean;
  defaultSpeed?: VjSpeed;
  loopMode?: VjLoopMode;
  loopInMs?: number | null;
  loopOutMs?: number | null;
}

/** A loop point as the body sends it: null, or a safe integer of at least 0
 *  milliseconds. Answers `VJ_CLIP_LOOP_INVALID`. */
function normalizeLoopPoint(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw vjError('VJ_CLIP_LOOP_INVALID');
  }
  return value;
}

/** Reads a clip update with contract 6.3 steps 2 to 7, in order: title, fit
 *  mode, favorite, default speed, loop mode, then the two loop points. An
 *  absent property is left out of the result; a present one is checked. The
 *  merged loop points are checked against the clip later, with
 *  `checkVjLoopPoints`. */
export function normalizeClipUpdate(
  body: UpdateVjClipDto,
): NormalizedVjClipUpdate {
  const update: NormalizedVjClipUpdate = {};
  if (body.title !== undefined) {
    update.title = normalizeClipTitle(body.title);
  }
  if (body.fitMode !== undefined) {
    update.fitMode = normalizeFitMode(body.fitMode);
  }
  if (body.isFavorite !== undefined) {
    if (typeof body.isFavorite !== 'boolean') {
      throw vjError('VJ_CLIP_FAVORITE_INVALID');
    }
    update.isFavorite = body.isFavorite;
  }
  if (body.defaultSpeed !== undefined) {
    const defaultSpeed = VJ_SPEEDS.find(
      (candidate) => candidate === body.defaultSpeed,
    );
    if (defaultSpeed === undefined) {
      throw vjError('VJ_CLIP_SPEED_INVALID');
    }
    update.defaultSpeed = defaultSpeed;
  }
  if (body.loopMode !== undefined) {
    const loopMode = VJ_LOOP_MODES.find(
      (candidate) => candidate === body.loopMode,
    );
    if (loopMode === undefined) {
      throw vjError('VJ_CLIP_LOOP_MODE_INVALID');
    }
    update.loopMode = loopMode;
  }
  if (body.loopInMs !== undefined) {
    update.loopInMs = normalizeLoopPoint(body.loopInMs);
  }
  if (body.loopOutMs !== undefined) {
    update.loopOutMs = normalizeLoopPoint(body.loopOutMs);
  }
  return update;
}

/** Checks a clip's merged loop points with the `CHK_vj_clips_loop_points`
 *  rule (contract 6.3 step 9): both null always passes; otherwise the clip is
 *  a video with a duration, each point lies within `0..durationMs`, and the
 *  span from `loopInMs` (or 0) to `loopOutMs` (or the duration) is at least
 *  `VJ_LIMITS.loopMinLengthMs`. Answers `VJ_CLIP_LOOP_INVALID`. */
export function checkVjLoopPoints(
  clip: { mediaKind: VjMediaKind; durationMs: number | null },
  loopInMs: number | null,
  loopOutMs: number | null,
): void {
  if (loopInMs === null && loopOutMs === null) {
    return;
  }
  const durationMs = clip.durationMs;
  if (clip.mediaKind !== 'video' || durationMs === null) {
    throw vjError('VJ_CLIP_LOOP_INVALID');
  }
  const isPointInside = (point: number | null): boolean =>
    point === null || (point >= 0 && point <= durationMs);
  if (!isPointInside(loopInMs) || !isPointInside(loopOutMs)) {
    throw vjError('VJ_CLIP_LOOP_INVALID');
  }
  const spanMs = (loopOutMs ?? durationMs) - (loopInMs ?? 0);
  if (spanMs < VJ_LIMITS.loopMinLengthMs) {
    throw vjError('VJ_CLIP_LOOP_INVALID');
  }
}

/** A scene name, trimmed. Answers `VJ_SCENE_NAME_REQUIRED` or
 *  `VJ_SCENE_NAME_TOO_LONG`. */
export function normalizeSceneName(value: unknown): string {
  return normalizeBoundedText(
    value,
    VJ_LIMITS.sceneNameMax,
    'VJ_SCENE_NAME_REQUIRED',
    'VJ_SCENE_NAME_TOO_LONG',
  );
}

/** A set list name, trimmed. Answers `VJ_SETLIST_NAME_REQUIRED` or
 *  `VJ_SETLIST_NAME_TOO_LONG`. */
export function normalizeSetlistName(value: unknown): string {
  return normalizeBoundedText(
    value,
    VJ_LIMITS.setlistNameMax,
    'VJ_SETLIST_NAME_REQUIRED',
    'VJ_SETLIST_NAME_TOO_LONG',
  );
}

/** Reads an optional `packId` body field: absent gives undefined (the stored
 *  pack stays), null gives null, a uuid comes back lowercased. Anything else
 *  answers `VJ_PACK_NOT_FOUND`. */
export function readOptionalPackId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isUuidText(value)) {
    throw vjError('VJ_PACK_NOT_FOUND');
  }
  return value.toLowerCase();
}

/** Reads the `eventId` body of `PATCH packs/:id/event`: null unlinks, a uuid
 *  comes back lowercased. Anything else, an absent field included, answers
 *  `VJ_EVENT_NOT_FOUND`. */
export function readEventIdBody(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (!isUuidText(value)) {
    throw vjError('VJ_EVENT_NOT_FOUND');
  }
  return value.toLowerCase();
}

/** Reads the required `clipIds` query of `GET clips/media`: 1 to 200
 *  comma-separated uuids, lowercased, a repeat kept once at its first place,
 *  in the query's order. Absent or empty answers `VJ_CLIP_IDS_INVALID`, as
 *  does every value `parseMediaClipIds` refuses. */
export function parseRequiredClipIds(value: unknown): string[] {
  if (value === undefined || value === '') {
    throw vjError('VJ_CLIP_IDS_INVALID');
  }
  const clipIds = parseMediaClipIds(value);
  if (clipIds === null || clipIds.length === 0) {
    throw vjError('VJ_CLIP_IDS_INVALID');
  }
  return clipIds;
}

/** Reads a create's `sceneIds`: an array of uuid strings, lowercased, in
 *  order, a repeat kept (a scene may play more than once). Anything but such
 *  an array, an absent value included, answers `VJ_SETLIST_ITEMS_INVALID`;
 *  over 100 entries answers `VJ_SETLIST_FULL` with `setlistId` when the set
 *  list exists. A create with no `sceneIds` passes `[]` itself. */
export function normalizeSetlistSceneIds(
  value: unknown,
  setlistId: string | null,
): string[] {
  if (!Array.isArray(value)) {
    throw vjError('VJ_SETLIST_ITEMS_INVALID');
  }
  const sceneIds: string[] = [];
  for (const entry of value as unknown[]) {
    if (!isUuidText(entry)) {
      throw vjError('VJ_SETLIST_ITEMS_INVALID');
    }
    sceneIds.push(entry.toLowerCase());
  }
  if (sceneIds.length > VJ_LIMITS.setlistItemsMax) {
    throw vjError('VJ_SETLIST_FULL', { setlistId: setlistId ?? undefined });
  }
  return sceneIds;
}

/** A step length (a sequence default or a step override), copied to a fresh
 *  `{ kind, value }`. Answers `VJ_SETLIST_STEP_DURATION_INVALID` for anything
 *  `isVjStepDuration` refuses. */
export function normalizeStepDuration(value: unknown): VjStepDuration {
  if (!isVjStepDuration(value)) {
    throw vjError('VJ_SETLIST_STEP_DURATION_INVALID');
  }
  return { kind: value.kind, value: value.value };
}

/** A sequence's Loop switch. Answers `VJ_SETLIST_LOOP_INVALID` for a
 *  non-boolean. */
export function normalizeSetlistLooping(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw vjError('VJ_SETLIST_LOOP_INVALID');
  }
  return value;
}

/** One step entry, lowercased ids; absent duration reads as null. */
export interface VjSetlistItemEntry {
  id: string | null;
  kind: VjSetlistItemKind;
  sceneId: string | null;
  clipId: string | null;
  duration: VjStepDuration | null;
}

/** The own keys a step entry may carry. */
const VJ_SETLIST_ITEM_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'sceneId',
  'clipId',
  'duration',
]);

/** Whether a value is an object literal as JSON parses it: no array, no null,
 *  no class instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads one step entry with the `VJ_SETLIST_STEP_INVALID` rules of contract
 *  4.4, in order: a plain object, only the five keys, a listed kind, the
 *  kind's target a uuid and the other target absent or null, a present `id`
 *  a uuid, then an `id` the body already used. The duration comes last and
 *  answers `VJ_SETLIST_STEP_DURATION_INVALID`. */
function normalizeSetlistItemEntry(
  value: unknown,
  seenItemIds: Set<string>,
): VjSetlistItemEntry {
  if (!isPlainRecord(value)) {
    throw vjError('VJ_SETLIST_STEP_INVALID');
  }
  if (Object.keys(value).some((key) => !VJ_SETLIST_ITEM_ENTRY_KEYS.has(key))) {
    throw vjError('VJ_SETLIST_STEP_INVALID');
  }
  const kind = VJ_SETLIST_ITEM_KINDS.find(
    (candidate) => candidate === value.kind,
  );
  if (kind === undefined) {
    throw vjError('VJ_SETLIST_STEP_INVALID');
  }
  const isOtherTargetSet =
    kind === 'scene'
      ? value.clipId !== undefined && value.clipId !== null
      : value.sceneId !== undefined && value.sceneId !== null;
  const target = kind === 'scene' ? value.sceneId : value.clipId;
  if (!isUuidText(target) || isOtherTargetSet) {
    throw vjError('VJ_SETLIST_STEP_INVALID');
  }
  const requestedItemId = value.id;
  let itemId: string | null = null;
  if (requestedItemId !== undefined) {
    if (!isUuidText(requestedItemId)) {
      throw vjError('VJ_SETLIST_STEP_INVALID');
    }
    itemId = requestedItemId.toLowerCase();
    if (seenItemIds.has(itemId)) {
      throw vjError('VJ_SETLIST_STEP_INVALID');
    }
    seenItemIds.add(itemId);
  }
  const requestedDuration = value.duration;
  const duration =
    requestedDuration === undefined || requestedDuration === null
      ? null
      : normalizeStepDuration(requestedDuration);
  const targetId = target.toLowerCase();
  return {
    id: itemId,
    kind,
    sceneId: kind === 'scene' ? targetId : null,
    clipId: kind === 'clip' ? targetId : null,
    duration,
  };
}

/** Reads the `items` of a whole-list write (`PUT setlists/:id/items`, or a
 *  create's `items`) with contract 4.4: not an array answers
 *  `VJ_SETLIST_ITEMS_INVALID`; over 100 entries answers `VJ_SETLIST_FULL`
 *  with `setlistId` when known; then each entry in list order answers
 *  `VJ_SETLIST_STEP_INVALID` or `VJ_SETLIST_STEP_DURATION_INVALID`. Ids come
 *  back lowercased; a scene or clip may repeat. */
export function normalizeSetlistItems(
  value: unknown,
  setlistId: string | null,
): VjSetlistItemEntry[] {
  if (!Array.isArray(value)) {
    throw vjError('VJ_SETLIST_ITEMS_INVALID');
  }
  const entries = value as unknown[];
  if (entries.length > VJ_LIMITS.setlistItemsMax) {
    throw vjError('VJ_SETLIST_FULL', { setlistId: setlistId ?? undefined });
  }
  const seenItemIds = new Set<string>();
  return entries.map((entry) => normalizeSetlistItemEntry(entry, seenItemIds));
}
