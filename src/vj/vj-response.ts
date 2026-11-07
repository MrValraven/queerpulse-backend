/**
 * Response shapes of the admin VJ routes (contract v2 6.1 over v1 5.1) and
 * the mappers that build them. Every object is a literal of its contract
 * fields, so a column added to an entity never reaches the wire, and no
 * object carries a storage key: media is addressed by URL only. Mappers take
 * structural row types, so this file imports no entity.
 */
import { toImageUrl } from '../common/image-url';
import type {
  VjClipMimeType,
  VjFitMode,
  VjLoopMode,
  VjMediaKind,
  VjSceneLook,
  VjSpeed,
} from './vj.contract';

/** The admin who created a pack, clip, scene or set list. */
export interface VjCreatorDTO {
  userId: string;
  /** `${firstName} ${lastName}`.trim() from profiles. */
  displayName: string;
}

/** The event a pack links, as the pack list shows it. */
export interface VjPackEventSummaryDTO {
  id: string;
  title: string;
  /** ISO. */
  startAt: string;
  /** False once the event is cancelled, unpublished or no longer public or members. */
  isAvailable: boolean;
}

export interface VjPackDTO {
  id: string;
  name: string;
  position: number;
  clipCount: number;
  /** Sum of its clips' byte size; 0 when empty. */
  totalByteSize: number;
  /** Thumbnail of the clip at position 0. */
  coverThumbnailUrl: string | null;
  /** Null when the column is null or the profile is gone. */
  createdBy: VjCreatorDTO | null;
  createdAt: string;
  updatedAt: string;
  /** Null when event_id is null. */
  event: VjPackEventSummaryDTO | null;
}

export interface VjClipDTO {
  id: string;
  title: string;
  mediaKind: VjMediaKind;
  mimeType: VjClipMimeType;
  byteSize: number;
  width: number;
  height: number;
  /** Null for a GIF. */
  durationMs: number | null;
  fitMode: VjFitMode;
  thumbnailUrl: string;
  /** Admin-only `/files` URL for the library preview. */
  mediaUrl: string;
  /** Every pack holding it, in pack position order. */
  packIds: string[];
  /** `packIds.length`; the delete dialog's count. */
  packCount: number;
  createdBy: VjCreatorDTO | null;
  createdAt: string;
  updatedAt: string;
  isFavorite: boolean;
  defaultSpeed: VjSpeed;
  loopInMs: number | null;
  loopOutMs: number | null;
  loopMode: VjLoopMode;
  /** toImageUrl(previewStorageKey), admin-only /files URL; null with no preview. */
  previewUrl: string | null;
}

/** Position order. */
export interface VjPackListDTO {
  items: VjPackDTO[];
}

/** `created_at DESC, id DESC`. */
export interface VjClipListDTO {
  items: VjClipDTO[];
}

/** Pack order. */
export interface VjPackClipsDTO {
  pack: VjPackDTO;
  items: VjClipDTO[];
}

export interface VjClipMediaDTO {
  clipId: string;
  /** Presigned GET, fetched with `credentials: 'omit'`. */
  url: string;
  /** ISO; the URL works for a fetch that starts before it. */
  expiresAt: string;
  mimeType: VjClipMimeType;
  byteSize: number;
}

export interface VjPackMediaDTO {
  packId: string;
  /** Pack order. */
  items: VjClipMediaDTO[];
}

/** `GET clips/media`, in the order of the query's clipIds. */
export interface VjClipMediaListDTO {
  items: VjClipMediaDTO[];
}

export interface VjPackDeletedDTO {
  deletedPackId: string;
  clipsKeptCount: number;
}

export interface VjClipDeletedDTO {
  deletedClipId: string;
  removedFromPackCount: number;
}

/** One upcoming event a pack may link. */
export interface VjEventOptionDTO {
  id: string;
  title: string;
  startAt: string;
  endAt: string | null;
  /** The event's neighbourhood; null when unset. */
  area: string | null;
  isOnline: boolean;
}

/** `start_at ASC, id ASC`. */
export interface VjEventOptionListDTO {
  items: VjEventOptionDTO[];
}

/** What the projector's event card shows. Host, attendees and address stay out. */
export interface VjEventCardDTO {
  eventId: string;
  title: string;
  startAt: string;
  endAt: string | null;
  /** IANA zone the host set, for the date line. */
  timezone: string;
  area: string | null;
  isOnline: boolean;
  /** `${app.frontendUrl}${gatheringPath(slug)}` (src/events/event-paths.ts); null when FRONTEND_URL is unset. */
  publicUrl: string | null;
}

/** Why a linked event's card may not show. */
export const VJ_EVENT_CARD_UNAVAILABLE_REASONS = [
  'cancelled',
  'not_listed',
] as const;
export type VjEventCardUnavailableReason =
  (typeof VJ_EVENT_CARD_UNAVAILABLE_REASONS)[number];

/** `GET packs/:id/event`. */
export interface VjPackEventDTO {
  packId: string;
  /** Null when the pack links no event, or the linked event is unavailable. */
  card: VjEventCardDTO | null;
  /** Set only when the pack links an event the card may not show. */
  unavailableReason: VjEventCardUnavailableReason | null;
}

export interface VjSceneDTO {
  id: string;
  name: string;
  packId: string | null;
  position: number;
  look: VjSceneLook;
  /** How many set list items name this scene; the delete dialog's count. */
  setlistItemCount: number;
  createdBy: VjCreatorDTO | null;
  createdAt: string;
  updatedAt: string;
}

/** `position ASC, id ASC`. */
export interface VjSceneListDTO {
  items: VjSceneDTO[];
}

export interface VjSceneDeletedDTO {
  deletedSceneId: string;
  removedFromSetlistCount: number;
}

export interface VjSetlistItemDTO {
  id: string;
  sceneId: string;
  position: number;
}

export interface VjSetlistDTO {
  id: string;
  name: string;
  position: number;
  /** `position ASC, id ASC`. */
  items: VjSetlistItemDTO[];
  createdBy: VjCreatorDTO | null;
  createdAt: string;
  updatedAt: string;
}

/** `position ASC, id ASC`. */
export interface VjSetlistListDTO {
  items: VjSetlistDTO[];
}

export interface VjSetlistDeletedDTO {
  deletedSetlistId: string;
}

/** `PATCH clips/:id` body (contract 6.3). */
export interface UpdateVjClipBody {
  title?: string;
  fitMode?: VjFitMode;
  isFavorite?: boolean;
  defaultSpeed?: VjSpeed;
  loopInMs?: number | null;
  loopOutMs?: number | null;
  loopMode?: VjLoopMode;
}

/** `POST scenes` body. */
export interface CreateVjSceneBody {
  name: string;
  packId?: string | null;
  look: VjSceneLook;
}

/** `PATCH scenes/:id` body. */
export interface UpdateVjSceneBody {
  name?: string;
  packId?: string | null;
  look?: VjSceneLook;
}

/** `POST setlists` body. */
export interface CreateVjSetlistBody {
  name: string;
  sceneIds?: string[];
}

/** The profile columns the creator name needs. */
export interface VjCreatorProfileRow {
  userId: string;
  firstName: string;
  lastName: string;
}

/** One pack with its aggregates, as the library service reads it. */
export interface VjPackSummaryRow {
  id: string;
  name: string;
  position: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  clipCount: number;
  totalByteSize: number;
  coverThumbnailKey: string | null;
}

/** The clip columns `toVjClip` reads; a `VjClip` entity satisfies it. */
export interface VjClipRow {
  id: string;
  title: string;
  mediaKind: VjMediaKind;
  mimeType: VjClipMimeType;
  byteSize: number;
  width: number;
  height: number;
  durationMs: number | null;
  storageKey: string;
  thumbnailStorageKey: string;
  fitMode: VjFitMode;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  isFavorite: boolean;
  defaultSpeed: VjSpeed;
  loopInMs: number | null;
  loopOutMs: number | null;
  loopMode: VjLoopMode;
  previewStorageKey: string | null;
}

/** The event columns the pack list reads for a linked event. */
export interface VjPackEventRow {
  id: string;
  title: string;
  startAt: Date;
  status: string;
  visibility: string;
}

/** The event columns the card and the upcoming list read; nothing else of
 *  the event reaches VJ. */
export interface VjEventRow {
  id: string;
  title: string;
  slug: string;
  startAt: Date;
  endAt: Date | null;
  timezone: string;
  neighbourhood: string | null;
  isOnline: boolean;
  status: string;
  visibility: string;
}

/** The scene columns `toVjScene` reads; the look comes in normalised. */
export interface VjSceneRow {
  id: string;
  name: string;
  packId: string | null;
  position: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The set list columns `toVjSetlist` reads. */
export interface VjSetlistRow {
  id: string;
  name: string;
  position: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One set list item as `toVjSetlist` reads it. */
export interface VjSetlistItemRow {
  id: string;
  sceneId: string;
  position: number;
}

/** The visibilities a listed event may have. */
const VJ_LISTED_EVENT_VISIBILITIES: readonly string[] = ['public', 'members'];

/** Names the creator from the profile map, or null when the column is null or
 *  the profile is gone. */
export function toVjCreator(
  userId: string | null,
  profiles: Map<string, VjCreatorProfileRow>,
): VjCreatorDTO | null {
  if (userId === null) {
    return null;
  }
  const profile = profiles.get(userId);
  if (!profile) {
    return null;
  }
  return {
    userId,
    displayName: `${profile.firstName} ${profile.lastName}`.trim(),
  };
}

/** Whether an event is listed: published, and public or members. */
export function isVjEventListed(row: {
  status: string;
  visibility: string;
}): boolean {
  return (
    row.status === 'published' &&
    VJ_LISTED_EVENT_VISIBILITIES.includes(row.visibility)
  );
}

/** A linked event as the pack list's summary; null when the pack links none. */
export function toVjPackEventSummary(
  row: VjPackEventRow | null,
): VjPackEventSummaryDTO | null {
  if (row === null) {
    return null;
  }
  return {
    id: row.id,
    title: row.title,
    startAt: row.startAt.toISOString(),
    isAvailable: isVjEventListed(row),
  };
}

/** A pack summary row as the contract's `VjPackDTO`. The event defaults to
 *  null for callers that read no event. */
export function toVjPack(
  row: VjPackSummaryRow,
  profiles: Map<string, VjCreatorProfileRow>,
  event: VjPackEventSummaryDTO | null = null,
): VjPackDTO {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    clipCount: Number(row.clipCount),
    totalByteSize: Number(row.totalByteSize),
    coverThumbnailUrl: toImageUrl(row.coverThumbnailKey),
    createdBy: toVjCreator(row.createdByUserId, profiles),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    event,
  };
}

/** A clip and the ids of every pack holding it as the contract's
 *  `VjClipDTO`. A key `toImageUrl` cannot resolve answers an empty URL; a
 *  null preview key answers a null `previewUrl`. */
export function toVjClip(
  clip: VjClipRow,
  packIds: string[],
  profiles: Map<string, VjCreatorProfileRow>,
): VjClipDTO {
  return {
    id: clip.id,
    title: clip.title,
    mediaKind: clip.mediaKind,
    mimeType: clip.mimeType,
    byteSize: clip.byteSize,
    width: clip.width,
    height: clip.height,
    durationMs: clip.durationMs,
    fitMode: clip.fitMode,
    thumbnailUrl: toImageUrl(clip.thumbnailStorageKey) ?? '',
    mediaUrl: toImageUrl(clip.storageKey) ?? '',
    packIds: [...packIds],
    packCount: packIds.length,
    createdBy: toVjCreator(clip.createdByUserId, profiles),
    createdAt: clip.createdAt.toISOString(),
    updatedAt: clip.updatedAt.toISOString(),
    isFavorite: clip.isFavorite,
    defaultSpeed: clip.defaultSpeed,
    loopInMs: clip.loopInMs,
    loopOutMs: clip.loopOutMs,
    loopMode: clip.loopMode,
    previewUrl: toImageUrl(clip.previewStorageKey),
  };
}

/** One signed preload item as the contract's `VjClipMediaDTO`. */
export function toVjClipMedia(
  clip: { id: string; mimeType: VjClipMimeType; byteSize: number },
  signed: { url: string; expiresAt: string },
): VjClipMediaDTO {
  return {
    clipId: clip.id,
    url: signed.url,
    expiresAt: signed.expiresAt,
    mimeType: clip.mimeType,
    byteSize: clip.byteSize,
  };
}

/** An event as one option of the upcoming list. */
export function toVjEventOption(row: VjEventRow): VjEventOptionDTO {
  return {
    id: row.id,
    title: row.title,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt === null ? null : row.endAt.toISOString(),
    area: row.neighbourhood,
    isOnline: row.isOnline,
  };
}

/** Why the card may not show a linked event: `cancelled` first, then
 *  `not_listed` for a draft or a visibility outside public and members; null
 *  when the card may show it. */
export function vjEventCardUnavailableReason(
  row: VjEventRow,
): VjEventCardUnavailableReason | null {
  if (row.status === 'cancelled') {
    return 'cancelled';
  }
  if (!isVjEventListed(row)) {
    return 'not_listed';
  }
  return null;
}

/** An event as the projector's card. `path` is `gatheringPath(row.slug)`;
 *  `publicUrl` is null when `frontendUrl` is empty. */
export function toVjEventCard(
  row: VjEventRow,
  frontendUrl: string | null | undefined,
  path: string,
): VjEventCardDTO {
  const baseUrl = frontendUrl ? frontendUrl.replace(/\/+$/, '') : '';
  return {
    eventId: row.id,
    title: row.title,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt === null ? null : row.endAt.toISOString(),
    timezone: row.timezone,
    area: row.neighbourhood,
    isOnline: row.isOnline,
    publicUrl: baseUrl === '' ? null : `${baseUrl}${path}`,
  };
}

/** A scene row and its normalised look as the contract's `VjSceneDTO`. */
export function toVjScene(
  row: VjSceneRow,
  look: VjSceneLook,
  setlistItemCount: number,
  profiles: Map<string, VjCreatorProfileRow>,
): VjSceneDTO {
  return {
    id: row.id,
    name: row.name,
    packId: row.packId,
    position: row.position,
    look,
    setlistItemCount: Number(setlistItemCount),
    createdBy: toVjCreator(row.createdByUserId, profiles),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A set list row and its items, copied in the order given, as the
 *  contract's `VjSetlistDTO`. */
export function toVjSetlist(
  row: VjSetlistRow,
  items: VjSetlistItemRow[],
  profiles: Map<string, VjCreatorProfileRow>,
): VjSetlistDTO {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    items: items.map((item) => ({
      id: item.id,
      sceneId: item.sceneId,
      position: item.position,
    })),
    createdBy: toVjCreator(row.createdByUserId, profiles),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
