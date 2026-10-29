import { EntityManager } from 'typeorm';
import { studioDownloadFormat } from './studio-purchase-rules';
import { StudioPurchaseDownloadTrack } from './studio-purchases-response';

/**
 * Contract 4.7 "Downloads after unlink". A purchase whose persona was unlinked
 * answers its downloads from `studio_purchase_kept_tracks` and
 * `studio_kept_tracks`. The kept rows point at no catalog row, so moderation of
 * the re-keyed catalog never reaches them: steps 3 to 7 of the live download
 * rules do not apply, only the state of the private copy does.
 */

/**
 * Kept rows whose copy keeps failing stop being retried after this many tries.
 * A missing source object jumps straight to this count, since no retry can
 * bring it back.
 */
export const KEPT_COPY_MAX_ATTEMPTS = 10;

export interface KeptTrackRow {
  purchase_id: string;
  kept_track_id: string;
  position: number;
  title: string;
  duration_seconds: number | null;
  audio_content_type: string;
  /** True while the source key is still held (the copy has not landed). */
  source_audio_key_present: boolean;
  /** The private copy's key; null until the copy lands. */
  audio_key: string | null;
  /** Failed copy tries; `KEPT_COPY_MAX_ATTEMPTS` means the copy gave up. */
  copy_attempts: number;
}

const KEPT_TRACK_COLUMNS_SQL = `"link"."purchase_id" AS "purchase_id",
       "kept"."id" AS "kept_track_id",
       "link"."position" AS "position",
       "kept"."title" AS "title",
       "kept"."duration_seconds" AS "duration_seconds",
       "kept"."audio_content_type" AS "audio_content_type",
       "kept"."source_audio_key" IS NOT NULL AS "source_audio_key_present",
       "kept"."audio_key" AS "audio_key",
       "kept"."copy_attempts" AS "copy_attempts"`;

/** `$1` purchase ids (uuid[]). The source key itself is never selected. */
export const KEPT_TRACKS_OF_PURCHASES_SQL = `SELECT ${KEPT_TRACK_COLUMNS_SQL}
  FROM "studio_purchase_kept_tracks" "link"
  INNER JOIN "studio_kept_tracks" "kept" ON "kept"."id" = "link"."kept_track_id"
 WHERE "link"."purchase_id" = ANY($1::uuid[])
 ORDER BY "link"."purchase_id" ASC, "link"."position" ASC, "kept"."id" ASC`;

/** `$1` the purchase, `$2` the kept track id: one row or none. */
export const KEPT_TRACK_OF_PURCHASE_SQL = `SELECT ${KEPT_TRACK_COLUMNS_SQL}
  FROM "studio_purchase_kept_tracks" "link"
  INNER JOIN "studio_kept_tracks" "kept" ON "kept"."id" = "link"."kept_track_id"
 WHERE "link"."purchase_id" = $1::uuid
   AND "link"."kept_track_id" = $2::uuid`;

export type KeptTrackRefusal =
  'studio_download_track_preparing' | 'studio_download_track_not_ready' | null;

/**
 * A copy that has not landed answers `preparing` while the source key is held
 * and a retry is left, and `not_ready` once the source is gone or the tries
 * ran out. A landed copy downloads.
 */
export function keptTrackDownloadRefusal(row: {
  audio_key: string | null;
  source_audio_key_present: boolean;
  copy_attempts: number;
}): KeptTrackRefusal {
  if (row.audio_key !== null) {
    return null;
  }
  return row.source_audio_key_present &&
    row.copy_attempts < KEPT_COPY_MAX_ATTEMPTS
    ? 'studio_download_track_preparing'
    : 'studio_download_track_not_ready';
}

/**
 * `$1` Studio audio keys (text[]): the ones a kept row still copies from, its
 * copy pending with a retry left.
 */
export const KEPT_SOURCE_KEYS_HELD_SQL = `SELECT DISTINCT "source_audio_key" AS "source_audio_key"
  FROM "studio_kept_tracks"
 WHERE "source_audio_key" = ANY($1::text[])
   AND "audio_key" IS NULL
   AND "copy_attempts" < ${KEPT_COPY_MAX_ATTEMPTS}`;

/**
 * Contract 4.7 "The copy": the Studio audio keys among `storageKeys` that no
 * pending kept copy still reads, so a track or release delete never pulls the
 * object out from under a copy. A held key stays in the bucket and the orphan
 * sweep reclaims it once the copy lands. When the check itself fails, every
 * key stays: a kept object outlives a lost copy.
 */
export async function withoutKeysHeldByKeptCopies(
  database: Pick<EntityManager, 'query'>,
  storageKeys: readonly string[],
): Promise<string[]> {
  if (storageKeys.length === 0) {
    return [];
  }
  try {
    const heldRows: { source_audio_key: string }[] = await database.query(
      KEPT_SOURCE_KEYS_HELD_SQL,
      [[...storageKeys]],
    );
    const heldKeys = new Set(
      heldRows.map((heldRow) => heldRow.source_audio_key),
    );
    return storageKeys.filter((storageKey) => !heldKeys.has(storageKey));
  } catch {
    return [];
  }
}

export function toKeptDownloadTrack(
  row: KeptTrackRow,
): StudioPurchaseDownloadTrack {
  return {
    trackId: row.kept_track_id,
    position: row.position,
    title: row.title,
    durationSeconds: row.duration_seconds,
    format: studioDownloadFormat(row.audio_content_type),
    unavailableReason: keptTrackDownloadRefusal(row),
  };
}
