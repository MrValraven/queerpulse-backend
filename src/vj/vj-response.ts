/**
 * Response shapes of the admin VJ routes (contract 5.1) and the mappers that
 * build them. Every object is a literal of its contract fields, so a column
 * added to an entity never reaches the wire, and no object carries a storage
 * key: media is addressed by URL only.
 */
import { toImageUrl } from '../common/image-url';
import type { VjClip } from './entities/vj-clip.entity';
import type { VjClipMimeType, VjFitMode, VjMediaKind } from './vj.contract';

/** The admin who created a pack or clip. */
export interface VjCreatorDTO {
  userId: string;
  /** `${firstName} ${lastName}`.trim() from profiles. */
  displayName: string;
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

export interface VjPackDeletedDTO {
  deletedPackId: string;
  clipsKeptCount: number;
}

export interface VjClipDeletedDTO {
  deletedClipId: string;
  removedFromPackCount: number;
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

/** A pack summary row as the contract's `VjPackDTO`. */
export function toVjPack(
  row: VjPackSummaryRow,
  profiles: Map<string, VjCreatorProfileRow>,
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
  };
}

/** A clip and the ids of every pack holding it as the contract's
 *  `VjClipDTO`. A key `toImageUrl` cannot resolve answers an empty URL. */
export function toVjClip(
  clip: VjClip,
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
  };
}

/** One signed preload item as the contract's `VjClipMediaDTO`. */
export function toVjClipMedia(
  clip: Pick<VjClip, 'id' | 'mimeType' | 'byteSize'>,
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
