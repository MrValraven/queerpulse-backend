import { HttpException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  isQuickTimeBrand,
  magicBytesMatchContentType,
} from '../storage/served-object';
import { isVjClipKey, isVjThumbnailKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import type {
  AddVjPackClipDto,
  CreateVjClipDto,
  CreateVjPackDto,
  RenameVjPackDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  UpdateVjClipDto,
  VjPackMediaQuery,
} from './dto/vj.dto';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import {
  isUuidText,
  type NormalizedVjClipCreate,
  normalizeClipCreate,
  normalizeClipUpdate,
  normalizeIdPermutation,
  normalizePackName,
  parseMediaClipIds,
} from './vj-input';
import {
  toVjClip,
  toVjClipMedia,
  toVjPack,
  type VjClipDeletedDTO,
  type VjClipDTO,
  type VjClipListDTO,
  type VjCreatorProfileRow,
  type VjPackClipsDTO,
  type VjPackDeletedDTO,
  type VjPackDTO,
  type VjPackListDTO,
  type VjPackMediaDTO,
  type VjPackSummaryRow,
} from './vj-response';
import { vjError } from './vj.constants';
import {
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
} from './vj.contract';

/** Who runs a VJ library write: the admin whose id lands in
 *  `created_by_user_id`. */
export type VjCaller = Pick<CurrentUserData, 'userId'>;

/** Pack create, rename, reorder and delete take this first, so the 50 cap,
 *  the case-insensitive name check and the dense positions hold under two
 *  admins writing at once. */
export const LOCK_VJ_PACKS_SQL =
  'LOCK TABLE "vj_packs" IN SHARE ROW EXCLUSIVE MODE';

/** Clip create takes this first, so the 1000 cap and the key checks hold
 *  under two admins creating at once. */
export const LOCK_VJ_CLIPS_SQL =
  'LOCK TABLE "vj_clips" IN SHARE ROW EXCLUSIVE MODE';

/** Clip delete takes this right after `LOCK_VJ_CLIPS_SQL` (the clip create
 *  lock order), so its position rewrite in every pack holding the clip never
 *  interleaves with a membership add, remove or reorder. */
export const LOCK_VJ_PACK_CLIPS_SQL =
  'LOCK TABLE "vj_pack_clips" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` one pack id, or null for every pack. One row per pack in position
 *  order with its clip count, the summed byte size of its clips and the
 *  thumbnail key of its first clip. */
export const VJ_PACK_SUMMARY_SQL = `SELECT "pack"."id", "pack"."name", "pack"."position", "pack"."created_by_user_id", "pack"."created_at", "pack"."updated_at",
  COUNT("clip"."id")::int AS "clip_count",
  COALESCE(SUM("clip"."byte_size"), 0)::bigint AS "total_byte_size",
  (SELECT "cover_clip"."thumbnail_storage_key" FROM "vj_pack_clips" "cover_pack_clip" JOIN "vj_clips" "cover_clip" ON "cover_clip"."id" = "cover_pack_clip"."clip_id" WHERE "cover_pack_clip"."pack_id" = "pack"."id" ORDER BY "cover_pack_clip"."position", "cover_pack_clip"."added_at", "cover_pack_clip"."clip_id" LIMIT 1) AS "cover_thumbnail_key"
FROM "vj_packs" "pack"
LEFT JOIN "vj_pack_clips" "pack_clip" ON "pack_clip"."pack_id" = "pack"."id"
LEFT JOIN "vj_clips" "clip" ON "clip"."id" = "pack_clip"."clip_id"
WHERE ($1::uuid IS NULL OR "pack"."id" = $1::uuid)
GROUP BY "pack"."id"
ORDER BY "pack"."position", "pack"."id"`;

/** `$1` clip ids. One `(clip_id, pack_id)` row per membership, in pack
 *  position order, so each clip's pack list reads in the order the library
 *  shows the packs. */
export const VJ_CLIP_PACK_IDS_SQL = `SELECT "pack_clip"."clip_id", "pack_clip"."pack_id" FROM "vj_pack_clips" "pack_clip" JOIN "vj_packs" "pack" ON "pack"."id" = "pack_clip"."pack_id" WHERE "pack_clip"."clip_id" = ANY($1::uuid[]) ORDER BY "pack"."position", "pack"."id"`;

/** `$1` a trimmed pack name, `$2` a pack id to leave out or null. The id of
 *  a pack holding the same name compared case-insensitively. */
export const VJ_PACK_NAME_HOLDER_SQL = `SELECT "id" FROM "vj_packs" WHERE lower("name") = lower($1) AND ($2::uuid IS NULL OR "id" <> $2::uuid) LIMIT 1`;

/** Rewrites pack positions to `0..n-1` in `position, id` order, touching
 *  only rows whose position differs. Raw SQL, so `updated_at` stays. */
export const DENSIFY_VJ_PACKS_SQL = `UPDATE "vj_packs" AS "pack" SET "position" = "ranked"."dense_position"
FROM (SELECT "id", (ROW_NUMBER() OVER (ORDER BY "position", "id") - 1)::int AS "dense_position" FROM "vj_packs") AS "ranked"
WHERE "pack"."id" = "ranked"."id" AND "pack"."position" <> "ranked"."dense_position"`;

/** `$1` pack ids. Rewrites each listed pack's clip positions to `0..n-1` in
 *  `position, added_at, clip_id` order, touching only rows whose position
 *  differs. */
export const DENSIFY_VJ_PACK_CLIPS_SQL = `UPDATE "vj_pack_clips" AS "pack_clip" SET "position" = "ranked"."dense_position"
FROM (SELECT "pack_id", "clip_id", (ROW_NUMBER() OVER (PARTITION BY "pack_id" ORDER BY "position", "added_at", "clip_id") - 1)::int AS "dense_position" FROM "vj_pack_clips" WHERE "pack_id" = ANY($1::uuid[])) AS "ranked"
WHERE "pack_clip"."pack_id" = "ranked"."pack_id" AND "pack_clip"."clip_id" = "ranked"."clip_id" AND "pack_clip"."position" <> "ranked"."dense_position"`;

const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
/** The membership row's reference to its clip; it fires when a clip delete
 *  commits between an add's clip read and its membership insert. */
const PACK_CLIP_CLIP_FOREIGN_KEY = 'FK_vj_pack_clips_clip';
const CLIP_STORAGE_KEY_UNIQUE = 'UQ_vj_clips_storage_key';
const CLIP_THUMBNAIL_KEY_UNIQUE = 'UQ_vj_clips_thumbnail_storage_key';
const THUMBNAIL_CONTENT_TYPE = 'image/webp';

/** One row of `VJ_PACK_SUMMARY_SQL` as the driver hands it back. */
interface VjPackSummaryRawRow {
  id: string;
  name: string;
  position: number;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  clip_count: number | string;
  total_byte_size: number | string;
  cover_thumbnail_key: string | null;
}

/** One row of `VJ_CLIP_PACK_IDS_SQL`. */
interface VjClipPackIdRow {
  clip_id: string;
  pack_id: string;
}

/** How one uploaded object of a clip create is checked (contract 5.3 steps
 *  8 to 10). */
interface VjUploadCheck {
  key: string;
  field: 'storageKey' | 'thumbnailStorageKey';
  kind: 'vj_clip' | 'vj_thumbnail';
  maxBytes: number;
  contentType: string;
  isKeyOfKind: (value: string) => boolean;
}

/** Why an upload check failed, and whether the failure means both uploads
 *  can never become a clip. */
class VjUploadRefusal extends Error {
  constructor(
    readonly refusal: HttpException,
    readonly shouldDiscardUploads: boolean,
  ) {
    super('VJ upload refused');
  }
}

/** A refusal for a write that guards no unique index. */
function noUniqueRefusal(): HttpException | null {
  return null;
}

/** `VJ_CLIP_KEY_IN_USE` naming the field whose unique index fired, or null
 *  for any other constraint. */
function clipKeyUniqueRefusal(constraint: string): HttpException | null {
  if (constraint === CLIP_STORAGE_KEY_UNIQUE) {
    return vjError('VJ_CLIP_KEY_IN_USE', { field: 'storageKey' });
  }
  if (constraint === CLIP_THUMBNAIL_KEY_UNIQUE) {
    return vjError('VJ_CLIP_KEY_IN_USE', { field: 'thumbnailStorageKey' });
  }
  return null;
}

/** The constraint name of a unique violation, or null for any other error. */
function violatedUniqueConstraintOf(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }
  const driverError = error.driverError as
    { code?: unknown; constraint?: unknown } | undefined;
  if (
    driverError?.code !== POSTGRES_UNIQUE_VIOLATION ||
    typeof driverError.constraint !== 'string'
  ) {
    return null;
  }
  return driverError.constraint;
}

/** True when `error` is a foreign key violation on `constraint`. */
function isForeignKeyViolationOn(error: unknown, constraint: string): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError = error.driverError as
    { code?: unknown; constraint?: unknown } | undefined;
  return (
    driverError?.code === POSTGRES_FOREIGN_KEY_VIOLATION &&
    driverError.constraint === constraint
  );
}

/** A route or body id lowercased, the form Postgres answers and the `/vj`
 *  gateway compares against; anything but a uuid answers `code`. */
function lowercaseIdOrRefuse(
  value: unknown,
  code: 'VJ_PACK_NOT_FOUND' | 'VJ_CLIP_NOT_FOUND',
): string {
  if (!isUuidText(value)) {
    throw vjError(code);
  }
  return value.toLowerCase();
}

/** A Date from a driver timestamp, which arrives as a Date or as text. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** A summary row with camelCase fields and its count and size text read as numbers. */
function toPackSummaryRow(raw: VjPackSummaryRawRow): VjPackSummaryRow {
  return {
    id: raw.id,
    name: raw.name,
    position: Number(raw.position),
    createdByUserId: raw.created_by_user_id,
    createdAt: asDate(raw.created_at),
    updatedAt: asDate(raw.updated_at),
    clipCount: Number(raw.clip_count),
    totalByteSize: Number(raw.total_byte_size),
    coverThumbnailKey: raw.cover_thumbnail_key,
  };
}

/**
 * The shared VJ library behind `admin/vj`: packs, clips, pack memberships,
 * the preload URLs a screen fetches, and the existence reads the `/vj`
 * socket runs. Every refusal goes through `vjError` with its contract code,
 * in the contract's check order, and a malformed id answers its not-found
 * code before any read. Ordered tables stay dense (`0..n-1`); every write
 * emits `VJ_LIBRARY_CHANGED` after its transaction commits. Nothing logs a
 * clip title or a pack name: log lines carry storage keys only.
 */
@Injectable()
export class VjLibraryService {
  private readonly logger = new Logger(VjLibraryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Every pack in position order. */
  async listPacks(): Promise<VjPackListDTO> {
    const manager = this.dataSource.manager;
    const rows = await this.readPackSummaries(manager, null);
    const profiles = await this.readCreatorProfiles(
      manager,
      rows.map((row) => row.createdByUserId),
    );
    return { items: rows.map((row) => toVjPack(row, profiles)) };
  }

  /** Appends a pack at the end of the list. The name is checked before the
   *  transaction; the cap and the name clash run under the table lock. */
  async createPack(
    caller: VjCaller,
    body: CreateVjPackDto,
  ): Promise<VjPackDTO> {
    const name = normalizePackName(body.name);
    const packId = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_PACKS_SQL);
      const packCount = await manager.count(VjPack);
      if (packCount >= VJ_LIMITS.packsMax) {
        throw vjError('VJ_PACK_LIMIT_REACHED');
      }
      await this.assertPackNameFree(manager, name, null);
      const pack = manager.create(VjPack, {
        name,
        position: packCount,
        createdByUserId: caller.userId,
      });
      const saved = await manager.save(VjPack, pack);
      return saved.id;
    }, noUniqueRefusal);
    this.emitChange({
      kind: 'pack_created',
      packId,
      clipId: null,
      packIds: [],
    });
    return this.readPack(packId);
  }

  /** Renames a pack. The stored name (same case) is a no-op with no write
   *  and no event; a case-only change is a rename. */
  async renamePack(
    requestedPackId: string,
    body: RenameVjPackDto,
  ): Promise<VjPackDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const name = normalizePackName(body.name);
    const isRenamed = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_PACKS_SQL);
      const pack = await manager.findOne(VjPack, {
        where: { id: packId },
        select: { id: true, name: true },
      });
      if (!pack) {
        throw vjError('VJ_PACK_NOT_FOUND');
      }
      if (pack.name === name) {
        return false;
      }
      await this.assertPackNameFree(manager, name, packId);
      await manager.update(VjPack, { id: packId }, { name });
      return true;
    }, noUniqueRefusal);
    if (isRenamed) {
      this.emitChange({
        kind: 'pack_renamed',
        packId,
        clipId: null,
        packIds: [],
      });
    }
    return this.readPack(packId);
  }

  /** Rewrites every pack's position to its index in `packIds`, which must
   *  name every pack exactly once. A mismatch writes nothing. */
  async reorderPacks(body: ReorderVjPacksDto): Promise<VjPackListDTO> {
    const isReordered = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_PACKS_SQL);
      const packs = await manager.find(VjPack, {
        select: { id: true, position: true },
        order: { position: 'ASC', id: 'ASC' },
      });
      const orderedIds = normalizeIdPermutation(
        body.packIds,
        packs.map((pack) => pack.id),
        'VJ_PACK_REORDER_MISMATCH',
      );
      const positionById = new Map(
        packs.map((pack) => [pack.id, pack.position]),
      );
      let hasChange = false;
      for (const [position, id] of orderedIds.entries()) {
        if (positionById.get(id) !== position) {
          await manager.update(VjPack, { id }, { position });
          hasChange = true;
        }
      }
      return hasChange;
    }, noUniqueRefusal);
    if (isReordered) {
      this.emitChange({
        kind: 'packs_reordered',
        packId: null,
        clipId: null,
        packIds: [],
      });
    }
    return this.listPacks();
  }

  /** Deletes a pack (its memberships cascade) and closes the gap in the
   *  pack positions. Every clip it held stays in the library. */
  async deletePack(requestedPackId: string): Promise<VjPackDeletedDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const clipsKeptCount = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_PACKS_SQL);
      const pack = await manager.findOne(VjPack, {
        where: { id: packId },
        select: { id: true },
      });
      if (!pack) {
        throw vjError('VJ_PACK_NOT_FOUND');
      }
      const memberCount = await manager.count(VjPackClip, {
        where: { packId },
      });
      await manager.delete(VjPack, { id: packId });
      await manager.query(DENSIFY_VJ_PACKS_SQL);
      return memberCount;
    }, noUniqueRefusal);
    this.emitChange({
      kind: 'pack_deleted',
      packId,
      clipId: null,
      packIds: [packId],
    });
    return { deletedPackId: packId, clipsKeptCount };
  }

  /** A pack with its clips in pack order. */
  async getPackClips(requestedPackId: string): Promise<VjPackClipsDTO> {
    return this.readPackClips(
      lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND'),
    );
  }

  /** Presigned GET URLs for a pack's clips in pack order, the screen's
   *  preload source. `clipIds` narrows to the listed clips the pack holds.
   *  No item carries a storage key. */
  async getPackMedia(
    requestedPackId: string,
    query: VjPackMediaQuery,
  ): Promise<VjPackMediaDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const manager = this.dataSource.manager;
    const packCount = await manager.count(VjPack, { where: { id: packId } });
    if (packCount === 0) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    const clipIds = parseMediaClipIds(query.clipIds);
    const memberships = await manager.find(VjPackClip, {
      where: clipIds === null ? { packId } : { packId, clipId: In(clipIds) },
      relations: { clip: true },
      order: { position: 'ASC', addedAt: 'ASC', clipId: 'ASC' },
    });
    const items = await Promise.all(
      memberships.map(async (membership) => {
        const signed = await this.storage.createPresignedVjClipDownload(
          membership.clip.storageKey,
          membership.clip.mimeType,
        );
        return toVjClipMedia(membership.clip, signed);
      }),
    );
    return { packId, items };
  }

  /** Appends a library clip at the end of a pack. The pack row is locked
   *  first, so the 200 cap and the end position hold. */
  async addPackClip(
    requestedPackId: string,
    body: AddVjPackClipDto,
  ): Promise<VjPackClipsDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const clipId = await this.runVjWrite(async (manager) => {
      await this.lockPack(manager, packId);
      const candidateClipId = lowercaseIdOrRefuse(
        body.clipId,
        'VJ_CLIP_NOT_FOUND',
      );
      await this.assertClipExists(manager, candidateClipId);
      const membership = await manager.findOne(VjPackClip, {
        where: { packId, clipId: candidateClipId },
        select: { packId: true },
      });
      if (membership) {
        throw vjError('VJ_CLIP_ALREADY_IN_PACK', { packId });
      }
      const memberCount = await manager.count(VjPackClip, {
        where: { packId },
      });
      if (memberCount >= VJ_LIMITS.packClipsMax) {
        throw vjError('VJ_PACK_FULL', { packId });
      }
      await manager.insert(VjPackClip, {
        packId,
        clipId: candidateClipId,
        position: memberCount,
      });
      return candidateClipId;
    }, noUniqueRefusal);
    this.emitChange({
      kind: 'pack_clips_changed',
      packId,
      clipId,
      packIds: [packId],
    });
    return this.readPackClips(packId);
  }

  /** Rewrites the pack's clip positions to their index in `clipIds`, which
   *  must name every clip of the pack exactly once. A mismatch writes
   *  nothing. */
  async reorderPackClips(
    requestedPackId: string,
    body: ReorderVjPackClipsDto,
  ): Promise<VjPackClipsDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const isReordered = await this.runVjWrite(async (manager) => {
      await this.lockPack(manager, packId);
      const memberships = await manager.find(VjPackClip, {
        where: { packId },
        select: { clipId: true, position: true },
        order: { position: 'ASC', addedAt: 'ASC', clipId: 'ASC' },
      });
      const orderedIds = normalizeIdPermutation(
        body.clipIds,
        memberships.map((membership) => membership.clipId),
        'VJ_PACK_CLIPS_REORDER_MISMATCH',
      );
      const positionByClipId = new Map(
        memberships.map((membership) => [
          membership.clipId,
          membership.position,
        ]),
      );
      let hasChange = false;
      for (const [position, clipId] of orderedIds.entries()) {
        if (positionByClipId.get(clipId) !== position) {
          await manager.update(VjPackClip, { packId, clipId }, { position });
          hasChange = true;
        }
      }
      return hasChange;
    }, noUniqueRefusal);
    if (isReordered) {
      this.emitChange({
        kind: 'pack_clips_changed',
        packId,
        clipId: null,
        packIds: [packId],
      });
    }
    return this.readPackClips(packId);
  }

  /** Takes a clip out of a pack and closes the gap. The clip and both of
   *  its stored objects stay in the library. */
  async removePackClip(
    requestedPackId: string,
    requestedClipId: string,
  ): Promise<VjPackClipsDTO> {
    const packId = lowercaseIdOrRefuse(requestedPackId, 'VJ_PACK_NOT_FOUND');
    const clipId = await this.runVjWrite(async (manager) => {
      await this.lockPack(manager, packId);
      const memberClipId = lowercaseIdOrRefuse(
        requestedClipId,
        'VJ_CLIP_NOT_FOUND',
      );
      await this.assertClipExists(manager, memberClipId);
      const membership = await manager.findOne(VjPackClip, {
        where: { packId, clipId: memberClipId },
        select: { packId: true },
      });
      if (!membership) {
        throw vjError('VJ_CLIP_NOT_IN_PACK', { packId });
      }
      await manager.delete(VjPackClip, { packId, clipId: memberClipId });
      await manager.query(DENSIFY_VJ_PACK_CLIPS_SQL, [[packId]]);
      return memberClipId;
    }, noUniqueRefusal);
    this.emitChange({
      kind: 'pack_clips_changed',
      packId,
      clipId,
      packIds: [packId],
    });
    return this.readPackClips(packId);
  }

  /** Every library clip, newest first. */
  async listClips(): Promise<VjClipListDTO> {
    const clips = await this.dataSource.manager.find(VjClip, {
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return { items: await this.toClipDtos(this.dataSource.manager, clips) };
  }

  /**
   * Creates a clip from two finished uploads (contract 5.3). The fields
   * are checked first, then both stored objects (size and first bytes),
   * then, under the clip table lock, the library cap, the keys and the
   * optional pack. A MOV, an empty or oversize object, or bytes that do not
   * match the key's type delete both uploads, since neither can ever become
   * a clip.
   */
  async createClip(
    caller: VjCaller,
    body: CreateVjClipDto,
  ): Promise<VjClipDTO> {
    const normalized = normalizeClipCreate(body);
    const byteSize = await this.inspectUploads(normalized);
    const clipId = await this.runVjWrite(
      (manager) => this.insertClip(manager, caller, normalized, byteSize),
      clipKeyUniqueRefusal,
    );
    if (normalized.packId === null) {
      this.emitChange({
        kind: 'clip_created',
        packId: null,
        clipId,
        packIds: [],
      });
    } else {
      this.emitChange({
        kind: 'pack_clips_changed',
        packId: normalized.packId,
        clipId,
        packIds: [normalized.packId],
      });
    }
    return this.readClip(clipId);
  }

  /** Changes a clip's title or fit mode. An absent property is left as it
   *  is, and an empty body answers the current clip with no write. */
  async updateClip(
    requestedClipId: string,
    body: UpdateVjClipDto,
  ): Promise<VjClipDTO> {
    const clipId = lowercaseIdOrRefuse(requestedClipId, 'VJ_CLIP_NOT_FOUND');
    const changes = normalizeClipUpdate(body);
    const hasChanges =
      changes.title !== undefined || changes.fitMode !== undefined;
    if (!hasChanges) {
      return this.readClip(clipId);
    }
    await this.runVjWrite(async (manager) => {
      await this.assertClipExists(manager, clipId);
      await manager.update(VjClip, { id: clipId }, changes);
    }, noUniqueRefusal);
    const clip = await this.readClip(clipId);
    this.emitChange({
      kind: 'clip_updated',
      packId: null,
      clipId,
      packIds: clip.packIds,
    });
    return clip;
  }

  /** Deletes a clip (its memberships cascade), closes the gap in every pack
   *  that held it, then deletes both stored objects after the commit. The
   *  clip table lock comes first and the membership table lock second (the
   *  clip create order), so no membership write interleaves with the
   *  position rewrite. A failed object delete is logged with the key only
   *  and left to the orphan sweep. */
  async deleteClip(requestedClipId: string): Promise<VjClipDeletedDTO> {
    const clipId = lowercaseIdOrRefuse(requestedClipId, 'VJ_CLIP_NOT_FOUND');
    const deleted = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_CLIPS_SQL);
      await manager.query(LOCK_VJ_PACK_CLIPS_SQL);
      const clip = await manager.findOne(VjClip, {
        where: { id: clipId },
        select: { id: true, storageKey: true, thumbnailStorageKey: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!clip) {
        throw vjError('VJ_CLIP_NOT_FOUND');
      }
      const rows: VjClipPackIdRow[] = await manager.query(
        VJ_CLIP_PACK_IDS_SQL,
        [[clipId]],
      );
      const packIds = rows.map((row) => row.pack_id);
      await manager.delete(VjClip, { id: clipId });
      if (packIds.length > 0) {
        await manager.query(DENSIFY_VJ_PACK_CLIPS_SQL, [packIds]);
      }
      return {
        storageKey: clip.storageKey,
        thumbnailStorageKey: clip.thumbnailStorageKey,
        packIds,
      };
    }, noUniqueRefusal);
    this.emitChange({
      kind: 'clip_deleted',
      packId: null,
      clipId,
      packIds: deleted.packIds,
    });
    await this.deleteStoredObject(deleted.storageKey);
    await this.deleteStoredObject(deleted.thumbnailStorageKey);
    return {
      deletedClipId: clipId,
      removedFromPackCount: deleted.packIds.length,
    };
  }

  /** Socket lookup: whether a pack has this id. One primary-key read; a
   *  malformed id answers false with no query. */
  async packExists(packId: string): Promise<boolean> {
    if (!isUuidText(packId)) {
      return false;
    }
    const count = await this.dataSource.manager.count(VjPack, {
      where: { id: packId.toLowerCase() },
    });
    return count > 0;
  }

  /** Socket lookup: whether a clip has this id. One primary-key read; a
   *  malformed id answers false with no query. */
  async clipExists(clipId: string): Promise<boolean> {
    if (!isUuidText(clipId)) {
      return false;
    }
    const count = await this.dataSource.manager.count(VjClip, {
      where: { id: clipId.toLowerCase() },
    });
    return count > 0;
  }

  /** Socket lookup: whether a pack holds a clip. One primary-key read; a
   *  malformed id answers false with no query. */
  async isClipInPack(packId: string, clipId: string): Promise<boolean> {
    if (!isUuidText(packId) || !isUuidText(clipId)) {
      return false;
    }
    const count = await this.dataSource.manager.count(VjPackClip, {
      where: { packId: packId.toLowerCase(), clipId: clipId.toLowerCase() },
    });
    return count > 0;
  }

  /** Contract 5.3 steps 8 to 10: the clip object, then the thumbnail. A
   *  refusal that means neither upload can become a clip deletes both
   *  before it is thrown, except a key a stored clip already holds. Answers
   *  the clip object's stored size. */
  private async inspectUploads(
    normalized: NormalizedVjClipCreate,
  ): Promise<number> {
    const clipCheck: VjUploadCheck = {
      key: normalized.storageKey,
      field: 'storageKey',
      kind: 'vj_clip',
      maxBytes: VJ_LIMITS.clipMaxBytes,
      contentType: normalized.mimeType,
      isKeyOfKind: isVjClipKey,
    };
    const thumbnailCheck: VjUploadCheck = {
      key: normalized.thumbnailStorageKey,
      field: 'thumbnailStorageKey',
      kind: 'vj_thumbnail',
      maxBytes: VJ_LIMITS.thumbnailMaxBytes,
      contentType: THUMBNAIL_CONTENT_TYPE,
      isKeyOfKind: isVjThumbnailKey,
    };
    try {
      const clipByteSize = await this.inspectUpload(clipCheck);
      await this.inspectUpload(thumbnailCheck);
      return clipByteSize;
    } catch (error) {
      if (!(error instanceof VjUploadRefusal)) {
        throw error;
      }
      if (error.shouldDiscardUploads) {
        await this.discardUnheldUploads(normalized);
      }
      throw error.refusal;
    }
  }

  /** Deletes the two uploads of a refused create, best effort, leaving any
   *  key a stored clip holds (a create may name another clip's key, which
   *  the key-in-use check only reaches in step 11). */
  private async discardUnheldUploads(
    normalized: NormalizedVjClipCreate,
  ): Promise<void> {
    const manager = this.dataSource.manager;
    const clipKeyHolderCount = await manager.count(VjClip, {
      where: { storageKey: normalized.storageKey },
    });
    if (clipKeyHolderCount === 0) {
      await this.deleteStoredObject(normalized.storageKey);
    }
    const thumbnailKeyHolderCount = await manager.count(VjClip, {
      where: { thumbnailStorageKey: normalized.thumbnailStorageKey },
    });
    if (thumbnailKeyHolderCount === 0) {
      await this.deleteStoredObject(normalized.thumbnailStorageKey);
    }
  }

  /** One uploaded object: present, non-empty, under its cap, and its first
   *  bytes match the type its key names. The key passes its VJ shape check
   *  before any storage read. Answers the stored size. */
  private async inspectUpload(check: VjUploadCheck): Promise<number> {
    if (!check.isKeyOfKind(check.key)) {
      throw new VjUploadRefusal(
        vjError('VJ_CLIP_KEY_INVALID', { field: check.field }),
        false,
      );
    }
    const missing = new VjUploadRefusal(
      vjError('VJ_UPLOAD_MISSING', { field: check.field }),
      false,
    );
    const mismatch = new VjUploadRefusal(
      vjError('VJ_UPLOAD_CONTENT_MISMATCH', { field: check.field }),
      true,
    );
    const stored = await this.storage.describeObject(check.key);
    if (stored === null) {
      throw missing;
    }
    if (stored.size <= 0) {
      throw mismatch;
    }
    if (stored.size > check.maxBytes) {
      throw new VjUploadRefusal(
        vjError('VJ_UPLOAD_TOO_LARGE', {
          kind: check.kind,
          maxBytes: check.maxBytes,
          field: check.field,
        }),
        true,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.readObjectPrefixBytes(check.key);
    } catch (error) {
      if (StorageService.isMissingObjectError(error)) {
        throw missing;
      }
      throw error;
    }
    if (check.kind === 'vj_clip' && isQuickTimeBrand(bytes)) {
      throw new VjUploadRefusal(
        vjError('VJ_UPLOAD_FORMAT_MOV', { field: check.field }),
        true,
      );
    }
    if (!magicBytesMatchContentType(bytes, check.contentType)) {
      throw mismatch;
    }
    return stored.size;
  }

  /** Contract 5.3 step 11, inside the transaction: the library cap and the
   *  key checks under the clip table lock, the optional pack read for
   *  update, then the clip row and its membership at the pack's end. */
  private async insertClip(
    manager: EntityManager,
    caller: VjCaller,
    normalized: NormalizedVjClipCreate,
    byteSize: number,
  ): Promise<string> {
    await manager.query(LOCK_VJ_CLIPS_SQL);
    const clipCount = await manager.count(VjClip);
    if (clipCount >= VJ_LIMITS.libraryClipsMax) {
      throw vjError('VJ_LIBRARY_FULL');
    }
    const storageKeyHolder = await manager.findOne(VjClip, {
      where: { storageKey: normalized.storageKey },
      select: { id: true },
    });
    if (storageKeyHolder) {
      throw vjError('VJ_CLIP_KEY_IN_USE', { field: 'storageKey' });
    }
    const thumbnailKeyHolder = await manager.findOne(VjClip, {
      where: { thumbnailStorageKey: normalized.thumbnailStorageKey },
      select: { id: true },
    });
    if (thumbnailKeyHolder) {
      throw vjError('VJ_CLIP_KEY_IN_USE', { field: 'thumbnailStorageKey' });
    }
    let memberCount = 0;
    if (normalized.packId !== null) {
      await this.lockPack(manager, normalized.packId);
      memberCount = await manager.count(VjPackClip, {
        where: { packId: normalized.packId },
      });
      if (memberCount >= VJ_LIMITS.packClipsMax) {
        throw vjError('VJ_PACK_FULL', { packId: normalized.packId });
      }
    }
    const clip = manager.create(VjClip, {
      title: normalized.title,
      mediaKind: normalized.mediaKind,
      mimeType: normalized.mimeType,
      byteSize,
      width: normalized.width,
      height: normalized.height,
      durationMs: normalized.durationMs,
      storageKey: normalized.storageKey,
      thumbnailStorageKey: normalized.thumbnailStorageKey,
      fitMode: normalized.fitMode,
      createdByUserId: caller.userId,
    });
    const saved = await manager.save(VjClip, clip);
    if (normalized.packId !== null) {
      await manager.insert(VjPackClip, {
        packId: normalized.packId,
        clipId: saved.id,
        position: memberCount,
      });
    }
    return saved.id;
  }

  /** Reads the pack row `FOR UPDATE`; an unknown id answers
   *  `VJ_PACK_NOT_FOUND`. */
  private async lockPack(
    manager: EntityManager,
    packId: string,
  ): Promise<void> {
    const pack = await manager.findOne(VjPack, {
      where: { id: packId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!pack) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
  }

  /** An unknown clip id answers `VJ_CLIP_NOT_FOUND`. */
  private async assertClipExists(
    manager: EntityManager,
    clipId: string,
  ): Promise<void> {
    const clip = await manager.findOne(VjClip, {
      where: { id: clipId },
      select: { id: true },
    });
    if (!clip) {
      throw vjError('VJ_CLIP_NOT_FOUND');
    }
  }

  /** A pack holding the same name case-insensitively, other than `exceptId`,
   *  answers `VJ_PACK_NAME_TAKEN` with the holder's id. */
  private async assertPackNameFree(
    manager: EntityManager,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const holders: { id: string }[] = await manager.query(
      VJ_PACK_NAME_HOLDER_SQL,
      [name, exceptId],
    );
    const holder = holders[0];
    if (holder) {
      throw vjError('VJ_PACK_NAME_TAKEN', { packId: holder.id });
    }
  }

  /** Summary rows for one pack, or every pack when `packId` is null. */
  private async readPackSummaries(
    manager: EntityManager,
    packId: string | null,
  ): Promise<VjPackSummaryRow[]> {
    const rows: VjPackSummaryRawRow[] = await manager.query(
      VJ_PACK_SUMMARY_SQL,
      [packId],
    );
    return rows.map(toPackSummaryRow);
  }

  /** The creator names for a set of user ids, in one read. */
  private async readCreatorProfiles(
    manager: EntityManager,
    userIds: readonly (string | null)[],
  ): Promise<Map<string, VjCreatorProfileRow>> {
    const uniqueIds = [
      ...new Set(userIds.filter((userId): userId is string => userId !== null)),
    ];
    const profiles = new Map<string, VjCreatorProfileRow>();
    if (uniqueIds.length === 0) {
      return profiles;
    }
    const rows = await manager.find(Profile, {
      where: { userId: In(uniqueIds) },
      select: { userId: true, firstName: true, lastName: true },
    });
    for (const row of rows) {
      profiles.set(row.userId, {
        userId: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
      });
    }
    return profiles;
  }

  /** One pack's DTO; a pack gone since the write answers
   *  `VJ_PACK_NOT_FOUND`. */
  private async readPack(packId: string): Promise<VjPackDTO> {
    const manager = this.dataSource.manager;
    const [row] = await this.readPackSummaries(manager, packId);
    if (!row) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    const profiles = await this.readCreatorProfiles(manager, [
      row.createdByUserId,
    ]);
    return toVjPack(row, profiles);
  }

  /** A pack with its clips in pack order, creators read in one batch. */
  private async readPackClips(packId: string): Promise<VjPackClipsDTO> {
    const manager = this.dataSource.manager;
    const [row] = await this.readPackSummaries(manager, packId);
    if (!row) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    const memberships = await manager.find(VjPackClip, {
      where: { packId },
      relations: { clip: true },
      order: { position: 'ASC', addedAt: 'ASC', clipId: 'ASC' },
    });
    const clips = memberships.map((membership) => membership.clip);
    const profiles = await this.readCreatorProfiles(manager, [
      row.createdByUserId,
      ...clips.map((clip) => clip.createdByUserId),
    ]);
    const packIdsByClip = await this.readClipPackIds(
      manager,
      clips.map((clip) => clip.id),
    );
    return {
      pack: toVjPack(row, profiles),
      items: clips.map((clip) =>
        toVjClip(clip, packIdsByClip.get(clip.id) ?? [], profiles),
      ),
    };
  }

  /** One clip's DTO; an unknown id answers `VJ_CLIP_NOT_FOUND`. */
  private async readClip(clipId: string): Promise<VjClipDTO> {
    const manager = this.dataSource.manager;
    const clip = await manager.findOne(VjClip, { where: { id: clipId } });
    if (!clip) {
      throw vjError('VJ_CLIP_NOT_FOUND');
    }
    const [dto] = await this.toClipDtos(manager, [clip]);
    if (!dto) {
      throw vjError('VJ_CLIP_NOT_FOUND');
    }
    return dto;
  }

  /** Clip DTOs with their pack lists and creators, each read in one batch. */
  private async toClipDtos(
    manager: EntityManager,
    clips: VjClip[],
  ): Promise<VjClipDTO[]> {
    if (clips.length === 0) {
      return [];
    }
    const packIdsByClip = await this.readClipPackIds(
      manager,
      clips.map((clip) => clip.id),
    );
    const profiles = await this.readCreatorProfiles(
      manager,
      clips.map((clip) => clip.createdByUserId),
    );
    return clips.map((clip) =>
      toVjClip(clip, packIdsByClip.get(clip.id) ?? [], profiles),
    );
  }

  /** Each clip's pack ids in pack position order, in one read. */
  private async readClipPackIds(
    manager: EntityManager,
    clipIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const packIdsByClip = new Map<string, string[]>();
    if (clipIds.length === 0) {
      return packIdsByClip;
    }
    const rows: VjClipPackIdRow[] = await manager.query(VJ_CLIP_PACK_IDS_SQL, [
      clipIds,
    ]);
    for (const row of rows) {
      const packIds = packIdsByClip.get(row.clip_id) ?? [];
      packIds.push(row.pack_id);
      packIdsByClip.set(row.clip_id, packIds);
    }
    return packIdsByClip;
  }

  /** Runs one library write in a transaction. A unique index that fires
   *  answers the refusal `onUnique` names for its constraint. A membership
   *  insert whose clip a concurrent delete removed answers
   *  `VJ_CLIP_NOT_FOUND`. Any other error is rethrown unchanged. */
  private async runVjWrite<Result>(
    work: (manager: EntityManager) => Promise<Result>,
    onUnique: (constraint: string) => HttpException | null,
  ): Promise<Result> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (isForeignKeyViolationOn(error, PACK_CLIP_CLIP_FOREIGN_KEY)) {
        throw vjError('VJ_CLIP_NOT_FOUND');
      }
      const constraint = violatedUniqueConstraintOf(error);
      const refusal = constraint === null ? null : onUnique(constraint);
      if (refusal) {
        throw refusal;
      }
      throw error;
    }
  }

  /** Announces a committed library write to the `/vj` gateway. */
  private emitChange(change: VjLibraryChange): void {
    this.eventEmitter.emit(VJ_LIBRARY_CHANGED, change);
  }

  /** Deletes one stored object, best effort. A failure logs the key only
   *  and leaves the object to the orphan sweep. */
  private async deleteStoredObject(key: string): Promise<void> {
    try {
      await this.storage.deleteObjectByKey(key);
    } catch {
      this.logger.warn(`VJ object delete failed: ${key}`);
    }
  }
}
