import { HttpException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  isQuickTimeBrand,
  magicBytesMatchContentType,
} from '../storage/served-object';
import {
  isVjClipKey,
  isVjPreviewKey,
  isVjThumbnailKey,
  vjPreviewContentTypeForKey,
} from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import type {
  AddVjPackClipDto,
  CreateVjClipDto,
  CreateVjPackDto,
  RenameVjPackDto,
  ReorderVjPackClipsDto,
  ReorderVjPacksDto,
  SetVjClipPreviewDto,
  UpdateVjClipDto,
  VjClipsMediaQuery,
  VjPackMediaQuery,
} from './dto/vj.dto';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import { VjScene } from './entities/vj-scene.entity';
import {
  checkVjLoopPoints,
  isUuidText,
  type NormalizedVjClipCreate,
  type NormalizedVjClipUpdate,
  normalizeClipCreate,
  normalizeClipUpdate,
  normalizeIdPermutation,
  normalizePackName,
  parseMediaClipIds,
  parseRequiredClipIds,
} from './vj-input';
import {
  buildVjLibraryChange,
  deleteVjStoredObject,
  lowercaseIdOrRefuse,
  runVjTransaction,
  type VjCaller,
  type VjTransactionRefusals,
} from './vj-library-kit';
import {
  readVjClipDto,
  readVjClipPackIds,
  readVjCreatorProfiles,
  readVjPackDto,
  readVjPackSummaries,
  toVjClipDtos,
} from './vj-library-reads';
import {
  toVjClip,
  toVjClipMedia,
  toVjPack,
  toVjPackEventSummary,
  type VjClipDeletedDTO,
  type VjClipDTO,
  type VjClipListDTO,
  type VjClipMediaListDTO,
  type VjPackClipsDTO,
  type VjPackDeletedDTO,
  type VjPackDTO,
  type VjPackListDTO,
  type VjPackMediaDTO,
} from './vj-response';
import {
  normalizeStoredVjSceneLook,
  withoutVjSceneClip,
} from './vj-scene-look';
import { LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL } from './vj-scene.service';
import { vjError } from './vj.constants';
import {
  VJ_LIBRARY_CHANGED,
  VJ_LIMITS,
  type VjLibraryChange,
  type VjLibraryChangeKind,
} from './vj.contract';

export type { VjCaller } from './vj-library-kit';

/** Pack create, rename, reorder and delete take this first, so the 50 cap,
 *  the case-insensitive name check and the dense positions hold under two
 *  admins writing at once. */
export const LOCK_VJ_PACKS_SQL =
  'LOCK TABLE "vj_packs" IN SHARE ROW EXCLUSIVE MODE';

/** Clip create takes this first, so the 1000 cap and the key checks hold
 *  under two admins creating at once. */
export const LOCK_VJ_CLIPS_SQL =
  'LOCK TABLE "vj_clips" IN SHARE ROW EXCLUSIVE MODE';

/** Clip PATCH and preview PUT take this before the clip row, so their row
 *  update waits behind a clip create or delete holding `LOCK_VJ_CLIPS_SQL`,
 *  and never holds the clip row while it waits on that table lock. Row
 *  exclusive lets two clip edits run at once. */
export const LOCK_VJ_CLIPS_ROW_EXCLUSIVE_SQL =
  'LOCK TABLE "vj_clips" IN ROW EXCLUSIVE MODE';

/** Clip delete takes this right after `LOCK_VJ_CLIPS_SQL` (the clip create
 *  lock order), so its position rewrite in every pack holding the clip never
 *  interleaves with a membership add, remove or reorder. */
export const LOCK_VJ_PACK_CLIPS_SQL =
  'LOCK TABLE "vj_pack_clips" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` one pack id, or null for every pack. One row per pack in position
 *  order with its clip count, the summed byte size of its clips and the
 *  thumbnail key of its first clip. The v1 read, kept for its spec; the
 *  service reads `VJ_PACK_SUMMARY_V2_SQL` (`vj-library-reads.ts`), which
 *  adds the linked event's summary. */
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

/** `$1` a deleted clip's id. Every scene whose look names the clip as its
 *  source or its mix clip, read `FOR UPDATE` inside the clip delete after
 *  the clip row lock and `LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL`, so the delete
 *  rewrites each look in its transaction. */
export const VJ_SCENES_NAMING_CLIP_SQL = `SELECT "id", "look" FROM "vj_scenes" WHERE "look"->'source'->>'clipId' = $1 OR "look"->'mix'->>'clipId' = $1 FOR UPDATE`;

/** The membership row's reference to its clip; it fires when a clip delete
 *  commits between an add's clip read and its membership insert. */
const PACK_CLIP_CLIP_FOREIGN_KEY = 'FK_vj_pack_clips_clip';
const CLIP_STORAGE_KEY_UNIQUE = 'UQ_vj_clips_storage_key';
const CLIP_THUMBNAIL_KEY_UNIQUE = 'UQ_vj_clips_thumbnail_storage_key';
const CLIP_PREVIEW_KEY_UNIQUE = 'UQ_vj_clips_preview_storage_key';
const THUMBNAIL_CONTENT_TYPE = 'image/webp';

/** Every library write: a membership insert whose clip a concurrent delete
 *  removed answers `VJ_CLIP_NOT_FOUND`. */
const LIBRARY_WRITE_REFUSALS: VjTransactionRefusals = {
  onForeignKey: new Map<string, () => HttpException>([
    [PACK_CLIP_CLIP_FOREIGN_KEY, () => vjError('VJ_CLIP_NOT_FOUND')],
  ]),
};

/** Clip create and preview writes: a key unique index that fires answers
 *  `VJ_CLIP_KEY_IN_USE` naming its field. */
const CLIP_KEY_WRITE_REFUSALS: VjTransactionRefusals = {
  onUnique: new Map<string, () => HttpException>([
    [
      CLIP_STORAGE_KEY_UNIQUE,
      () => vjError('VJ_CLIP_KEY_IN_USE', { field: 'storageKey' }),
    ],
    [
      CLIP_THUMBNAIL_KEY_UNIQUE,
      () => vjError('VJ_CLIP_KEY_IN_USE', { field: 'thumbnailStorageKey' }),
    ],
    [
      CLIP_PREVIEW_KEY_UNIQUE,
      () => vjError('VJ_CLIP_KEY_IN_USE', { field: 'previewStorageKey' }),
    ],
  ]),
  onForeignKey: LIBRARY_WRITE_REFUSALS.onForeignKey,
};

/** Every field a clip PATCH may change (contract 6.3). */
const VJ_CLIP_UPDATE_FIELDS = [
  'title',
  'fitMode',
  'isFavorite',
  'defaultSpeed',
  'loopInMs',
  'loopOutMs',
  'loopMode',
] as const satisfies readonly (keyof NormalizedVjClipUpdate)[];

type VjClipUpdateField = (typeof VJ_CLIP_UPDATE_FIELDS)[number];

/** The playback defaults a stage picks up on a tap (contract 7.10:
 *  `clip_defaults_changed`). */
const VJ_CLIP_DEFAULT_FIELDS: readonly VjClipUpdateField[] = [
  'defaultSpeed',
  'loopInMs',
  'loopOutMs',
  'loopMode',
];

/** One row of `VJ_SCENES_NAMING_CLIP_SQL`. */
interface VjSceneLookRow {
  id: string;
  look: unknown;
}

/** One row of `VJ_CLIP_PACK_IDS_SQL`. */
interface VjClipPackIdRow {
  clip_id: string;
  pack_id: string;
}

/** What a preview write changed: whether the key moved, and the key it
 *  replaced (null when the clip had no preview). */
interface VjPreviewWrite {
  isChanged: boolean;
  replacedKey: string | null;
}

/** How one uploaded object is checked (contract 5.3 steps 8 to 10, and
 *  contract 6.4 steps 3 and 4 for a preview). */
interface VjUploadCheck {
  key: string;
  field: 'storageKey' | 'thumbnailStorageKey' | 'previewStorageKey';
  kind: 'vj_clip' | 'vj_thumbnail' | 'vj_preview';
  maxBytes: number;
  contentType: string | null;
  isKeyOfKind: (value: string) => boolean;
}

/** Why an upload check failed, and whether the failure means the upload
 *  can never become usable. */
class VjUploadRefusal extends Error {
  constructor(
    readonly refusal: HttpException,
    readonly shouldDiscardUploads: boolean,
  ) {
    super('VJ upload refused');
  }
}

/** Whether a normalized clip update carries any field at all. */
function hasClipUpdateFields(changes: NormalizedVjClipUpdate): boolean {
  return VJ_CLIP_UPDATE_FIELDS.some((field) => changes[field] !== undefined);
}

/** The update fields whose value differs from the stored clip, in the
 *  contract's field order. */
function changedClipFields(
  clip: VjClip,
  changes: NormalizedVjClipUpdate,
): VjClipUpdateField[] {
  return VJ_CLIP_UPDATE_FIELDS.filter(
    (field) => changes[field] !== undefined && changes[field] !== clip[field],
  );
}

/** The change kind contract 7.10 gives a clip PATCH: a title or fit mode
 *  change is `clip_updated`, else a loop or speed default change is
 *  `clip_defaults_changed`, else the favorite flag changed. */
function clipUpdateKindOf(
  fields: readonly VjClipUpdateField[],
): VjLibraryChangeKind {
  if (fields.includes('title') || fields.includes('fitMode')) {
    return 'clip_updated';
  }
  if (fields.some((field) => VJ_CLIP_DEFAULT_FIELDS.includes(field))) {
    return 'clip_defaults_changed';
  }
  return 'clip_favorite_changed';
}

/** The `previewStorageKey` body field as a preview key; anything else
 *  answers `VJ_CLIP_KEY_INVALID` (contract 6.4 step 2). */
function readPreviewStorageKey(value: unknown): string {
  if (typeof value !== 'string' || !isVjPreviewKey(value)) {
    throw vjError('VJ_CLIP_KEY_INVALID', { field: 'previewStorageKey' });
  }
  return value;
}

/**
 * The shared VJ library behind `admin/vj`: packs, clips, pack memberships,
 * clip defaults and previews, the preload URLs a screen fetches, and the
 * existence reads the `/vj` socket runs. Every refusal goes through `vjError`
 * with its contract code, in the contract's check order, and a malformed id
 * answers its not-found code before any read. Ordered tables stay dense
 * (`0..n-1`); every write emits `VJ_LIBRARY_CHANGED` after its transaction
 * commits. Nothing logs a clip title, a pack name or a scene look: log lines
 * carry storage keys only.
 */
@Injectable()
export class VjLibraryService {
  private readonly logger = new Logger(VjLibraryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Every pack in position order, each with its linked event's summary. */
  async listPacks(): Promise<VjPackListDTO> {
    const manager = this.dataSource.manager;
    const rows = await readVjPackSummaries(manager, null);
    const profiles = await readVjCreatorProfiles(
      manager,
      rows.map((row) => row.summary.createdByUserId),
    );
    return {
      items: rows.map((row) =>
        toVjPack(row.summary, profiles, toVjPackEventSummary(row.event)),
      ),
    };
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
    });
    this.emitChange('pack_created', { packId });
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
    });
    if (isRenamed) {
      this.emitChange('pack_renamed', { packId });
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
    });
    if (isReordered) {
      this.emitChange('packs_reordered', {});
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
    });
    this.emitChange('pack_deleted', { packId, packIds: [packId] });
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

  /** Presigned GET URLs for listed clips from any pack, in the query's
   *  order (contract 6.2 "Clips media"). One read; an unknown id is left
   *  out, which a screen reads as `not_found`. No item carries a storage
   *  key. */
  async getClipsMedia(query: VjClipsMediaQuery): Promise<VjClipMediaListDTO> {
    const clipIds = parseRequiredClipIds(query.clipIds);
    const clips = await this.dataSource.manager.find(VjClip, {
      where: { id: In(clipIds) },
      select: { id: true, storageKey: true, mimeType: true, byteSize: true },
    });
    const clipById = new Map(clips.map((clip) => [clip.id, clip]));
    const listedClips = clipIds
      .map((clipId) => clipById.get(clipId))
      .filter((clip): clip is VjClip => clip !== undefined);
    const items = await Promise.all(
      listedClips.map(async (clip) => {
        const signed = await this.storage.createPresignedVjClipDownload(
          clip.storageKey,
          clip.mimeType,
        );
        return toVjClipMedia(clip, signed);
      }),
    );
    return { items };
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
    });
    this.emitChange('pack_clips_changed', {
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
    });
    if (isReordered) {
      this.emitChange('pack_clips_changed', { packId, packIds: [packId] });
    }
    return this.readPackClips(packId);
  }

  /** Takes a clip out of a pack and closes the gap. The clip and its
   *  stored objects stay in the library. */
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
    });
    this.emitChange('pack_clips_changed', {
      packId,
      clipId,
      packIds: [packId],
    });
    return this.readPackClips(packId);
  }

  /** Every library clip, newest first. */
  async listClips(): Promise<VjClipListDTO> {
    const manager = this.dataSource.manager;
    const clips = await manager.find(VjClip, {
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return { items: await toVjClipDtos(manager, clips) };
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
    const clipId = await runVjTransaction(
      this.dataSource,
      (manager) => this.insertClip(manager, caller, normalized, byteSize),
      CLIP_KEY_WRITE_REFUSALS,
    );
    if (normalized.packId === null) {
      this.emitChange('clip_created', { clipId });
    } else {
      this.emitChange('pack_clips_changed', {
        packId: normalized.packId,
        clipId,
        packIds: [normalized.packId],
      });
    }
    return this.readClip(clipId);
  }

  /**
   * Changes a clip's title, fit mode, favorite flag or playback defaults
   * (contract 6.3). Steps 2 to 7 run before any read; the clip is then read
   * `FOR UPDATE` and the merged loop points are checked against it. An
   * empty body answers the current clip with no transaction, and a body
   * equal to the stored values writes nothing and emits nothing. The kind
   * emitted follows contract 7.10.
   */
  async updateClip(
    requestedClipId: string,
    body: UpdateVjClipDto,
  ): Promise<VjClipDTO> {
    const clipId = lowercaseIdOrRefuse(requestedClipId, 'VJ_CLIP_NOT_FOUND');
    const changes = normalizeClipUpdate(body);
    if (!hasClipUpdateFields(changes)) {
      return this.readClip(clipId);
    }
    const changeKind = await this.runVjWrite((manager) =>
      this.writeClipUpdate(manager, clipId, changes),
    );
    const clip = await this.readClip(clipId);
    if (changeKind !== null) {
      this.emitChange(changeKind, { clipId, packIds: clip.packIds });
    }
    return clip;
  }

  /**
   * Stores a clip's animated preview (contract 6.4). The key passes its
   * shape check, then the uploaded object its size and first bytes; an
   * unusable upload no clip holds is deleted. Under the clip row lock a key
   * another clip stores answers `VJ_CLIP_KEY_IN_USE`. The clip's current key
   * again is a no-op; a replaced older preview is deleted after the commit.
   */
  async setClipPreview(
    requestedClipId: string,
    body: SetVjClipPreviewDto,
  ): Promise<VjClipDTO> {
    const clipId = lowercaseIdOrRefuse(requestedClipId, 'VJ_CLIP_NOT_FOUND');
    const previewKey = readPreviewStorageKey(body.previewStorageKey);
    await this.inspectPreviewUpload(previewKey);
    const write = await runVjTransaction(
      this.dataSource,
      (manager) => this.writeClipPreview(manager, clipId, previewKey),
      CLIP_KEY_WRITE_REFUSALS,
    );
    const clip = await this.readClip(clipId);
    if (write.isChanged) {
      this.emitChange('clip_preview_changed', {
        clipId,
        packIds: clip.packIds,
      });
      await this.deleteStoredObject(write.replacedKey);
    }
    return clip;
  }

  /** Deletes a clip (its memberships cascade), rewrites every scene look
   *  naming it, closes the gap in every pack that held it, then deletes its
   *  three stored objects after the commit. The clip table lock comes first
   *  and the membership table lock second (the clip create order), then
   *  the clip row, the scene table lock in row exclusive mode and the
   *  scenes naming it `FOR UPDATE`. A failed object
   *  delete is logged with the key only and left to the orphan sweep. */
  async deleteClip(requestedClipId: string): Promise<VjClipDeletedDTO> {
    const clipId = lowercaseIdOrRefuse(requestedClipId, 'VJ_CLIP_NOT_FOUND');
    const deleted = await this.runVjWrite(async (manager) => {
      await manager.query(LOCK_VJ_CLIPS_SQL);
      await manager.query(LOCK_VJ_PACK_CLIPS_SQL);
      const clip = await manager.findOne(VjClip, {
        where: { id: clipId },
        select: {
          id: true,
          storageKey: true,
          thumbnailStorageKey: true,
          previewStorageKey: true,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!clip) {
        throw vjError('VJ_CLIP_NOT_FOUND');
      }
      await this.rewriteScenesNamingClip(manager, clipId);
      const rows: VjClipPackIdRow[] = await manager.query(
        VJ_CLIP_PACK_IDS_SQL,
        [[clipId]],
      );
      const packIds = rows.map((row) => row.pack_id);
      await manager.delete(VjClip, { id: clipId });
      if (packIds.length > 0) {
        await manager.query(DENSIFY_VJ_PACK_CLIPS_SQL, [packIds]);
      }
      return { clip, packIds };
    });
    this.emitChange('clip_deleted', { clipId, packIds: deleted.packIds });
    await this.deleteStoredObject(deleted.clip.storageKey);
    await this.deleteStoredObject(deleted.clip.thumbnailStorageKey);
    await this.deleteStoredObject(deleted.clip.previewStorageKey);
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

  /** Contract 6.3 steps 8 and 9 inside the transaction: the clip table
   *  lock in row exclusive mode, the clip read `FOR UPDATE`, the merged loop
   *  points checked, then only the fields that differ written. Answers the
   *  change kind, or null when the body equals the stored clip. */
  private async writeClipUpdate(
    manager: EntityManager,
    clipId: string,
    changes: NormalizedVjClipUpdate,
  ): Promise<VjLibraryChangeKind | null> {
    await manager.query(LOCK_VJ_CLIPS_ROW_EXCLUSIVE_SQL);
    const clip = await manager.findOne(VjClip, {
      where: { id: clipId },
      select: {
        id: true,
        mediaKind: true,
        durationMs: true,
        title: true,
        fitMode: true,
        isFavorite: true,
        defaultSpeed: true,
        loopInMs: true,
        loopOutMs: true,
        loopMode: true,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!clip) {
      throw vjError('VJ_CLIP_NOT_FOUND');
    }
    checkVjLoopPoints(
      clip,
      changes.loopInMs === undefined ? clip.loopInMs : changes.loopInMs,
      changes.loopOutMs === undefined ? clip.loopOutMs : changes.loopOutMs,
    );
    const changedFields = changedClipFields(clip, changes);
    if (changedFields.length === 0) {
      return null;
    }
    const values: Record<string, unknown> = {};
    for (const field of changedFields) {
      values[field] = changes[field];
    }
    await manager.update(VjClip, { id: clipId }, values);
    return clipUpdateKindOf(changedFields);
  }

  /** Contract 6.4 step 5 inside the transaction: the clip table lock in
   *  row exclusive mode, the clip read `FOR UPDATE`, the current key again
   *  left as it is, a key another clip stores refused, then the new key
   *  set. */
  private async writeClipPreview(
    manager: EntityManager,
    clipId: string,
    previewKey: string,
  ): Promise<VjPreviewWrite> {
    await manager.query(LOCK_VJ_CLIPS_ROW_EXCLUSIVE_SQL);
    const clip = await manager.findOne(VjClip, {
      where: { id: clipId },
      select: { id: true, previewStorageKey: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!clip) {
      throw vjError('VJ_CLIP_NOT_FOUND');
    }
    if (clip.previewStorageKey === previewKey) {
      return { isChanged: false, replacedKey: null };
    }
    const holder = await manager.findOne(VjClip, {
      where: { previewStorageKey: previewKey },
      select: { id: true },
    });
    if (holder) {
      throw vjError('VJ_CLIP_KEY_IN_USE', { field: 'previewStorageKey' });
    }
    await manager.update(
      VjClip,
      { id: clipId },
      { previewStorageKey: previewKey },
    );
    return { isChanged: true, replacedKey: clip.previewStorageKey };
  }

  /** Rewrites every scene look naming a deleted clip, inside the clip
   *  delete: each stored look goes through the read normaliser, then loses
   *  the clip (source to null, mix to no clip at amount 0). */
  private async rewriteScenesNamingClip(
    manager: EntityManager,
    clipId: string,
  ): Promise<void> {
    await manager.query(LOCK_VJ_SCENES_ROW_EXCLUSIVE_SQL);
    const scenes: VjSceneLookRow[] = await manager.query(
      VJ_SCENES_NAMING_CLIP_SQL,
      [clipId],
    );
    for (const scene of scenes) {
      const look = withoutVjSceneClip(
        normalizeStoredVjSceneLook(scene.look),
        clipId,
      );
      if (look !== null) {
        await manager.update(VjScene, { id: scene.id }, { look });
      }
    }
  }

  /** Contract 6.4 steps 3 and 4: the uploaded preview is present, non-empty,
   *  under 512 KB, and its first bytes match the type its extension names
   *  (a QuickTime brand never does). An empty, oversize or mismatched upload
   *  no clip holds is deleted before the refusal is thrown; a missing one is
   *  left alone. */
  private async inspectPreviewUpload(previewKey: string): Promise<void> {
    try {
      await this.inspectUpload({
        key: previewKey,
        field: 'previewStorageKey',
        kind: 'vj_preview',
        maxBytes: VJ_LIMITS.previewMaxBytes,
        contentType: vjPreviewContentTypeForKey(previewKey),
        isKeyOfKind: isVjPreviewKey,
      });
    } catch (error) {
      if (!(error instanceof VjUploadRefusal)) {
        throw error;
      }
      if (error.shouldDiscardUploads) {
        const holderCount = await this.dataSource.manager.count(VjClip, {
          where: { previewStorageKey: previewKey },
        });
        if (holderCount === 0) {
          await this.deleteStoredObject(previewKey);
        }
      }
      throw error.refusal;
    }
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
   *  before any storage read. A QuickTime brand answers
   *  `VJ_UPLOAD_FORMAT_MOV` for a clip and `VJ_UPLOAD_CONTENT_MISMATCH` for
   *  a preview. Answers the stored size. */
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
    if (check.kind !== 'vj_thumbnail' && isQuickTimeBrand(bytes)) {
      throw check.kind === 'vj_clip'
        ? new VjUploadRefusal(
            vjError('VJ_UPLOAD_FORMAT_MOV', { field: check.field }),
            true,
          )
        : mismatch;
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

  /** One pack's DTO with its event summary; a pack gone since the write
   *  answers `VJ_PACK_NOT_FOUND`. */
  private async readPack(packId: string): Promise<VjPackDTO> {
    return readVjPackDto(this.dataSource.manager, packId);
  }

  /** A pack (with its event summary) and its clips in pack order, creators
   *  read in one batch. */
  private async readPackClips(packId: string): Promise<VjPackClipsDTO> {
    const manager = this.dataSource.manager;
    const [row] = await readVjPackSummaries(manager, packId);
    if (!row) {
      throw vjError('VJ_PACK_NOT_FOUND');
    }
    const memberships = await manager.find(VjPackClip, {
      where: { packId },
      relations: { clip: true },
      order: { position: 'ASC', addedAt: 'ASC', clipId: 'ASC' },
    });
    const clips = memberships.map((membership) => membership.clip);
    const profiles = await readVjCreatorProfiles(manager, [
      row.summary.createdByUserId,
      ...clips.map((clip) => clip.createdByUserId),
    ]);
    const packIdsByClip = await readVjClipPackIds(
      manager,
      clips.map((clip) => clip.id),
    );
    return {
      pack: toVjPack(row.summary, profiles, toVjPackEventSummary(row.event)),
      items: clips.map((clip) =>
        toVjClip(clip, packIdsByClip.get(clip.id) ?? [], profiles),
      ),
    };
  }

  /** One clip's DTO; an unknown id answers `VJ_CLIP_NOT_FOUND`. */
  private async readClip(clipId: string): Promise<VjClipDTO> {
    return readVjClipDto(this.dataSource.manager, clipId);
  }

  /** Runs one library write in a transaction. A membership insert whose
   *  clip a concurrent delete removed answers `VJ_CLIP_NOT_FOUND`; any other
   *  error is rethrown unchanged. */
  private runVjWrite<Result>(
    work: (manager: EntityManager) => Promise<Result>,
  ): Promise<Result> {
    return runVjTransaction(this.dataSource, work, LIBRARY_WRITE_REFUSALS);
  }

  /** Announces a committed library write to the `/vj` gateway, every field
   *  the write leaves unset filled with null or an empty list. */
  private emitChange(
    kind: VjLibraryChangeKind,
    fields: Partial<Omit<VjLibraryChange, 'kind'>>,
  ): void {
    this.eventEmitter.emit(
      VJ_LIBRARY_CHANGED,
      buildVjLibraryChange(kind, fields),
    );
  }

  /** Deletes one stored object, best effort. A failure logs the key only
   *  and leaves the object to the orphan sweep; a null key deletes
   *  nothing. */
  private async deleteStoredObject(key: string | null): Promise<void> {
    await deleteVjStoredObject(this.storage, this.logger, key);
  }
}
