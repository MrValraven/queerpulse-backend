import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { KEPT_COPY_MAX_ATTEMPTS } from './studio-kept-tracks';
import { STUDIO_KEPT_AUDIO_PENDING } from './studio-purchase.events';
import { describePlayErrorWithoutIds } from './studio-play-log';

/** Rows one pending read returns; a full batch means another read follows. */
export const PENDING_KEPT_COPIES_BATCH_SIZE = 200;

/**
 * Rows still waiting for their private copy: no copy yet, the source key still
 * held, fewer than ten failed tries. Oldest first, 200 per batch. `$1` and `$2`
 * are the last batch's `created_at_cursor` and id (both null for the first
 * batch), so each run tries a row once. The cursor is the timestamp as text,
 * which keeps its microseconds through the round trip.
 */
export const PENDING_KEPT_COPIES_SQL = `SELECT "id", "source_audio_key", "audio_content_type", "created_at"::text AS "created_at_cursor"
  FROM "studio_kept_tracks"
 WHERE "audio_key" IS NULL
   AND "source_audio_key" IS NOT NULL
   AND "copy_attempts" < ${KEPT_COPY_MAX_ATTEMPTS}
   AND ($1::timestamptz IS NULL OR ("created_at", "id") > ($1::timestamptz, $2::uuid))
 ORDER BY "created_at" ASC, "id" ASC
 LIMIT ${PENDING_KEPT_COPIES_BATCH_SIZE}`;

/**
 * `$1` the kept row, `$2` the new key. The copy lands only while the row still
 * has no copy, so of two runs that copied the same row exactly one keeps its
 * object. The statement is wrapped in `WITH` so the driver returns rows.
 */
export const KEPT_COPY_LANDED_SQL = `WITH "landed" AS (UPDATE "studio_kept_tracks" SET "audio_key" = $2, "source_audio_key" = NULL WHERE "id" = $1 AND "audio_key" IS NULL RETURNING "id") SELECT COUNT(*)::int AS "landed_count" FROM "landed"`;

/** `$1` the kept row. */
export const KEPT_COPY_FAILED_SQL = `UPDATE "studio_kept_tracks"
   SET "copy_attempts" = "copy_attempts" + 1
 WHERE "id" = $1
   AND "audio_key" IS NULL`;

/**
 * `$1` the kept row whose source object is gone: no retry can copy it, so the
 * row takes its last try at once and downloads answer `not_ready`. The source
 * key stays (the table's CHECK needs one key) and stops counting as held.
 */
export const KEPT_COPY_ABANDONED_SQL = `UPDATE "studio_kept_tracks"
   SET "copy_attempts" = ${KEPT_COPY_MAX_ATTEMPTS}
 WHERE "id" = $1
   AND "audio_key" IS NULL`;

/** `$1` the kept row: its recorded copy key, read after a landing that threw. */
export const KEPT_COPY_KEY_SQL = `SELECT "audio_key" FROM "studio_kept_tracks" WHERE "id" = $1`;

/** Purchases nobody can read any more: no buyer account and no buyer persona. */
export const ORPHAN_PURCHASES_DELETE_SQL = `DELETE FROM "studio_purchases"
 WHERE "buyer_user_id" IS NULL
   AND "subprofile_id" IS NULL`;

/** Kept rows no purchase links to, with the copy to delete first. */
export const ORPHAN_KEPT_TRACKS_SQL = `SELECT "kept"."id" AS "id", "kept"."audio_key" AS "audio_key"
  FROM "studio_kept_tracks" "kept"
 WHERE NOT EXISTS (
         SELECT 1
           FROM "studio_purchase_kept_tracks" "link"
          WHERE "link"."kept_track_id" = "kept"."id"
       )
 ORDER BY "kept"."created_at" ASC, "kept"."id" ASC
 LIMIT 500`;

/** `$1` the kept row. The link check repeats so a late link keeps the row. */
export const KEPT_TRACK_DELETE_SQL = `DELETE FROM "studio_kept_tracks" "kept"
 WHERE "kept"."id" = $1
   AND NOT EXISTS (
         SELECT 1
           FROM "studio_purchase_kept_tracks" "link"
          WHERE "link"."kept_track_id" = "kept"."id"
       )`;

interface PendingKeptCopyRow {
  id: string;
  source_audio_key: string;
  audio_content_type: string;
  created_at_cursor: string;
}

interface OrphanKeptTrackRow {
  id: string;
  audio_key: string | null;
}

/**
 * Contract 4.7 "The copy" and "Sweep". After a persona unlink commits, each
 * confirmed buyer's tracks wait in `studio_kept_tracks` with the live track's
 * key. This service copies each object to a private key of its own, records
 * the copy and clears the source key.
 *
 * Why a copy: the live track's key appears in its presigned stream URL, so a
 * buyer comparing their download URL with the re-keyed track's stream URL
 * could tie the pseudonymous persona to its past. The copy has its own key.
 *
 * Rows run one at a time. The object copy happens outside any transaction,
 * then a conditional update records it, so two runs never both keep a copy.
 * Logs carry the error class and the Postgres code only: no key, title or id.
 * Every public method catches its own failures, since an event handler and a
 * cron tick have nobody to await them.
 */
@Injectable()
export class StudioKeptAudioService {
  private readonly logger = new Logger(StudioKeptAudioService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  /** The unlink service's signal that kept rows are waiting for their copy. */
  @OnEvent(STUDIO_KEPT_AUDIO_PENDING)
  async copyPending(): Promise<void> {
    await this.copyPendingRows();
  }

  /** The daily cron's retry of rows with fewer than ten failed tries. */
  async retryPendingCopies(): Promise<void> {
    await this.copyPendingRows();
  }

  /**
   * The daily cron's sweep: purchases nobody can read go first, then each
   * kept row no purchase links, its copy deleted before the row. A failed
   * object delete leaves the row for the next run.
   */
  async sweepOrphans(): Promise<void> {
    try {
      await this.dataSource.query(ORPHAN_PURCHASES_DELETE_SQL);
      const orphanRows: OrphanKeptTrackRow[] = await this.dataSource.query(
        ORPHAN_KEPT_TRACKS_SQL,
      );
      for (const orphanRow of orphanRows) {
        await this.deleteOrphan(orphanRow);
      }
    } catch (error) {
      this.logger.warn(
        `studio kept audio sweep failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async deleteOrphan(orphanRow: OrphanKeptTrackRow): Promise<void> {
    try {
      if (orphanRow.audio_key !== null) {
        await this.storage.deleteObjectByKey(orphanRow.audio_key);
      }
      await this.dataSource.query(KEPT_TRACK_DELETE_SQL, [orphanRow.id]);
    } catch (error) {
      this.logger.warn(
        `studio kept audio sweep failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async copyPendingRows(): Promise<void> {
    try {
      let cursorCreatedAt: string | null = null;
      let cursorId: string | null = null;
      let hasMoreRows = true;
      while (hasMoreRows) {
        const pendingRows: PendingKeptCopyRow[] = await this.dataSource.query(
          PENDING_KEPT_COPIES_SQL,
          [cursorCreatedAt, cursorId],
        );
        for (const pendingRow of pendingRows) {
          await this.copyOneRow(pendingRow);
        }
        const lastRow = pendingRows[pendingRows.length - 1];
        hasMoreRows =
          pendingRows.length >= PENDING_KEPT_COPIES_BATCH_SIZE &&
          lastRow !== undefined;
        cursorCreatedAt = lastRow?.created_at_cursor ?? null;
        cursorId = lastRow?.id ?? null;
      }
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async copyOneRow(pendingRow: PendingKeptCopyRow): Promise<void> {
    let keptKey: string;
    try {
      keptKey = await this.storage.copyStudioAudioForKeeping(
        pendingRow.source_audio_key,
        pendingRow.audio_content_type,
      );
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy failed: ${describePlayErrorWithoutIds(error)}`,
      );
      if (StorageService.isMissingObjectError(error)) {
        await this.abandonCopy(pendingRow.id);
      } else {
        await this.countFailedCopy(pendingRow.id);
      }
      return;
    }
    let landedCount: number;
    try {
      const landedRows: { landed_count: number }[] =
        await this.dataSource.query(KEPT_COPY_LANDED_SQL, [
          pendingRow.id,
          keptKey,
        ]);
      landedCount = Number(landedRows[0]?.landed_count ?? 0);
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy failed: ${describePlayErrorWithoutIds(error)}`,
      );
      // The update may have committed before the error reached us, so the
      // row is read again: the copy goes only when the row names another key
      // (or the row is gone). When that read fails too, the object stays and
      // the storage orphan sweep reclaims it if no row names it.
      const recordedKey = await this.readRecordedCopyKey(pendingRow.id);
      if (recordedKey.isRead && recordedKey.audioKey === keptKey) {
        return;
      }
      if (recordedKey.isRead) {
        await this.deleteUnlandedCopy(keptKey);
      }
      await this.countFailedCopy(pendingRow.id);
      return;
    }
    if (landedCount === 0) {
      // Another run landed its own copy first: this one is unreferenced.
      await this.deleteUnlandedCopy(keptKey);
    }
  }

  private async deleteUnlandedCopy(keptKey: string): Promise<void> {
    try {
      await this.storage.deleteObjectByKey(keptKey);
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy cleanup failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async readRecordedCopyKey(
    keptTrackId: string,
  ): Promise<{ isRead: boolean; audioKey: string | null }> {
    try {
      const keyRows: { audio_key: string | null }[] =
        await this.dataSource.query(KEPT_COPY_KEY_SQL, [keptTrackId]);
      return { isRead: true, audioKey: keyRows[0]?.audio_key ?? null };
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy check failed: ${describePlayErrorWithoutIds(error)}`,
      );
      return { isRead: false, audioKey: null };
    }
  }

  private async abandonCopy(keptTrackId: string): Promise<void> {
    try {
      await this.dataSource.query(KEPT_COPY_ABANDONED_SQL, [keptTrackId]);
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }

  private async countFailedCopy(keptTrackId: string): Promise<void> {
    try {
      await this.dataSource.query(KEPT_COPY_FAILED_SQL, [keptTrackId]);
    } catch (error) {
      this.logger.warn(
        `studio kept audio copy failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }
}
