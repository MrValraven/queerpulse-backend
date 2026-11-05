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
  VJ_FIT_MODES,
  VJ_LIMITS,
  type VjClipMimeType,
  type VjFitMode,
  type VjMediaKind,
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
  code: 'VJ_PACK_REORDER_MISMATCH' | 'VJ_PACK_CLIPS_REORDER_MISMATCH',
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

/** Reads a clip update: an absent property is left out of the result, a
 *  present one is checked (title first, then fit mode). */
export function normalizeClipUpdate(body: UpdateVjClipDto): {
  title?: string;
  fitMode?: VjFitMode;
} {
  const update: { title?: string; fitMode?: VjFitMode } = {};
  if (body.title !== undefined) {
    update.title = normalizeClipTitle(body.title);
  }
  if (body.fitMode !== undefined) {
    update.fitMode = normalizeFitMode(body.fitMode);
  }
  return update;
}
