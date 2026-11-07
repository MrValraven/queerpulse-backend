import { EntityManager, In } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { VjClip } from './entities/vj-clip.entity';
import { asVjDate } from './vj-library-kit';
import {
  toVjClip,
  toVjPack,
  toVjPackEventSummary,
  type VjClipDTO,
  type VjCreatorProfileRow,
  type VjPackDTO,
  type VjPackEventRow,
  type VjPackSummaryRow,
} from './vj-response';
import { vjError } from './vj.constants';

/**
 * The reads that build pack and clip DTOs, shared by every VJ library
 * service: pack summaries with the linked event's summary, creator names,
 * each clip's pack list, and the one-row DTO reads a write answers with.
 * Every list reads in one query; nothing here writes or logs.
 */

/** `$1` one pack id, or null for every pack. One row per pack in position
 *  order with its clip count, the summed byte size of its clips, the
 *  thumbnail key of its first clip, and the linked event's `id`, `title`,
 *  `start_at`, `status` and `visibility` (all null with no link). Selects
 *  nothing else of the event. */
export const VJ_PACK_SUMMARY_V2_SQL = `SELECT "pack"."id", "pack"."name", "pack"."position", "pack"."created_by_user_id", "pack"."created_at", "pack"."updated_at",
  COUNT("clip"."id")::int AS "clip_count",
  COALESCE(SUM("clip"."byte_size"), 0)::bigint AS "total_byte_size",
  (SELECT "cover_clip"."thumbnail_storage_key" FROM "vj_pack_clips" "cover_pack_clip" JOIN "vj_clips" "cover_clip" ON "cover_clip"."id" = "cover_pack_clip"."clip_id" WHERE "cover_pack_clip"."pack_id" = "pack"."id" ORDER BY "cover_pack_clip"."position", "cover_pack_clip"."added_at", "cover_pack_clip"."clip_id" LIMIT 1) AS "cover_thumbnail_key",
  "event"."id" AS "event_id", "event"."title" AS "event_title", "event"."start_at" AS "event_start_at", "event"."status" AS "event_status", "event"."visibility" AS "event_visibility"
FROM "vj_packs" "pack"
LEFT JOIN "events" "event" ON "event"."id" = "pack"."event_id"
LEFT JOIN "vj_pack_clips" "pack_clip" ON "pack_clip"."pack_id" = "pack"."id"
LEFT JOIN "vj_clips" "clip" ON "clip"."id" = "pack_clip"."clip_id"
WHERE ($1::uuid IS NULL OR "pack"."id" = $1::uuid)
GROUP BY "pack"."id", "event"."id"
ORDER BY "pack"."position", "pack"."id"`;

/** `$1` clip ids. One `(clip_id, pack_id)` row per membership, in pack
 *  position order, so each clip's pack list reads in the order the library
 *  shows the packs. */
const VJ_CLIP_PACK_IDS_READ_SQL = `SELECT "pack_clip"."clip_id", "pack_clip"."pack_id" FROM "vj_pack_clips" "pack_clip" JOIN "vj_packs" "pack" ON "pack"."id" = "pack_clip"."pack_id" WHERE "pack_clip"."clip_id" = ANY($1::uuid[]) ORDER BY "pack"."position", "pack"."id"`;

/** One row of `VJ_PACK_SUMMARY_V2_SQL` as the driver hands it back. */
interface VjPackSummaryV2RawRow {
  id: string;
  name: string;
  position: number;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  clip_count: number | string;
  total_byte_size: number | string;
  cover_thumbnail_key: string | null;
  event_id: string | null;
  event_title: string | null;
  event_start_at: Date | string | null;
  event_status: string | null;
  event_visibility: string | null;
}

/** One row of `VJ_CLIP_PACK_IDS_READ_SQL`. */
interface VjClipPackIdRow {
  clip_id: string;
  pack_id: string;
}

/** One pack's summary and its linked event, null with no link. */
export interface VjPackSummaryWithEvent {
  summary: VjPackSummaryRow;
  event: VjPackEventRow | null;
}

/** A summary row with camelCase fields and its count and size text read as
 *  numbers. */
function toPackSummaryRow(raw: VjPackSummaryV2RawRow): VjPackSummaryRow {
  return {
    id: raw.id,
    name: raw.name,
    position: Number(raw.position),
    createdByUserId: raw.created_by_user_id,
    createdAt: asVjDate(raw.created_at),
    updatedAt: asVjDate(raw.updated_at),
    clipCount: Number(raw.clip_count),
    totalByteSize: Number(raw.total_byte_size),
    coverThumbnailKey: raw.cover_thumbnail_key,
  };
}

/** The linked event's five columns, or null when the pack links none. */
function toPackEventRow(raw: VjPackSummaryV2RawRow): VjPackEventRow | null {
  if (raw.event_id === null || raw.event_start_at === null) {
    return null;
  }
  return {
    id: raw.event_id,
    title: raw.event_title ?? '',
    startAt: asVjDate(raw.event_start_at),
    status: raw.event_status ?? '',
    visibility: raw.event_visibility ?? '',
  };
}

/** Summary rows with their event for one pack, or every pack when `packId`
 *  is null, in one read. */
export async function readVjPackSummaries(
  manager: EntityManager,
  packId: string | null,
): Promise<VjPackSummaryWithEvent[]> {
  const rows: VjPackSummaryV2RawRow[] = await manager.query(
    VJ_PACK_SUMMARY_V2_SQL,
    [packId],
  );
  return rows.map((raw) => ({
    summary: toPackSummaryRow(raw),
    event: toPackEventRow(raw),
  }));
}

/** The creator names for a set of user ids, in one read; no read for an
 *  empty or all-null list. */
export async function readVjCreatorProfiles(
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

/** Each clip's pack ids in pack position order, in one read; no read for an
 *  empty list. */
export async function readVjClipPackIds(
  manager: EntityManager,
  clipIds: readonly string[],
): Promise<Map<string, string[]>> {
  const packIdsByClip = new Map<string, string[]>();
  if (clipIds.length === 0) {
    return packIdsByClip;
  }
  const rows: VjClipPackIdRow[] = await manager.query(
    VJ_CLIP_PACK_IDS_READ_SQL,
    [clipIds],
  );
  for (const row of rows) {
    const packIds = packIdsByClip.get(row.clip_id) ?? [];
    packIds.push(row.pack_id);
    packIdsByClip.set(row.clip_id, packIds);
  }
  return packIdsByClip;
}

/** Clip DTOs with their pack lists and creators, each read in one batch. */
export async function toVjClipDtos(
  manager: EntityManager,
  clips: VjClip[],
): Promise<VjClipDTO[]> {
  if (clips.length === 0) {
    return [];
  }
  const packIdsByClip = await readVjClipPackIds(
    manager,
    clips.map((clip) => clip.id),
  );
  const profiles = await readVjCreatorProfiles(
    manager,
    clips.map((clip) => clip.createdByUserId),
  );
  return clips.map((clip) =>
    toVjClip(clip, packIdsByClip.get(clip.id) ?? [], profiles),
  );
}

/** One pack's DTO with its event summary; a pack gone since the write
 *  answers `VJ_PACK_NOT_FOUND`. */
export async function readVjPackDto(
  manager: EntityManager,
  packId: string,
): Promise<VjPackDTO> {
  const [row] = await readVjPackSummaries(manager, packId);
  if (!row) {
    throw vjError('VJ_PACK_NOT_FOUND');
  }
  const profiles = await readVjCreatorProfiles(manager, [
    row.summary.createdByUserId,
  ]);
  return toVjPack(row.summary, profiles, toVjPackEventSummary(row.event));
}

/** One clip's DTO; a clip gone since the write answers
 *  `VJ_CLIP_NOT_FOUND`. */
export async function readVjClipDto(
  manager: EntityManager,
  clipId: string,
): Promise<VjClipDTO> {
  const clip = await manager.findOne(VjClip, { where: { id: clipId } });
  if (!clip) {
    throw vjError('VJ_CLIP_NOT_FOUND');
  }
  const [dto] = await toVjClipDtos(manager, [clip]);
  if (!dto) {
    throw vjError('VJ_CLIP_NOT_FOUND');
  }
  return dto;
}
