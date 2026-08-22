import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { CinemaService } from './cinema.service';
import { CinemaTitle, TitleStatus } from './entities/cinema-title.entity';
import { MuxService } from './mux.service';
import { TitleDetail, toTitleDetail } from './title-response';

// A title mid-ingest that hasn't moved in this long gets polled against the
// Mux API — covers lost/undelivered webhooks without any queue infrastructure.
const STUCK_AFTER_MS = 15 * 60 * 1000;

const FAILED_UPLOAD_STATUSES = new Set(['errored', 'cancelled', 'timed_out']);

/**
 * Postgres advisory-lock key for the hourly sweep (CNT-16).
 *
 * `@Cron` fires in EVERY app replica, so without a lock a two-replica deploy
 * polls Mux twice per stuck title every hour and two workers `save()` the same
 * row concurrently — the transitions themselves are idempotent, but
 * `lastIngestEventAt`/`errorMessage` can still lose an update. One
 * `pg_try_advisory_lock` makes the sweep single-flight across the whole
 * cluster with no queue infrastructure: whoever wins runs it, everybody else
 * returns immediately.
 *
 * Advisory locks live in a single global namespace shared by every session on
 * the database, so this constant must stay unique across the codebase. It is
 * currently the only advisory lock in `src/`. Chosen arbitrarily but
 * memorably; do not reuse it for another job.
 */
const RECONCILE_ADVISORY_LOCK_KEY = 793640001;

@Injectable()
export class CinemaReconciliationService {
  private readonly logger = new Logger(CinemaReconciliationService.name);

  constructor(
    @InjectRepository(CinemaTitle)
    private readonly titles: Repository<CinemaTitle>,
    private readonly cinema: CinemaService,
    private readonly mux: MuxService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Hourly stuck-ingest sweep, held to ONE replica by a Postgres advisory lock
   * (CNT-16).
   *
   * The lock is taken on a DEDICATED `QueryRunner`, not through the repository:
   * `pg_advisory_lock` is session-scoped, and a pooled query gives no guarantee
   * that the unlock lands on the same connection that took it. The runner is
   * held for the duration of the sweep and released in `finally`, so a crash
   * mid-sweep frees the lock when the connection drops rather than wedging the
   * job forever.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async reconcile(): Promise<void> {
    if (!this.config.get<string>('mux.tokenId')) {
      return; // Mux not configured — nothing to reconcile against
    }

    const lockRunner = this.dataSource.createQueryRunner();
    await lockRunner.connect();
    try {
      // `QueryRunner.query` is untyped (unlike `DataSource.query<T>`), hence
      // the assertion rather than a type argument.
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [RECONCILE_ADVISORY_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        // Another replica is already sweeping. Nothing to log at warn level —
        // this is the expected outcome on every replica but one.
        this.logger.debug(
          'Cinema reconciliation skipped: another replica holds the sweep lock',
        );
        return;
      }
      try {
        await this.sweepStuckTitles();
      } finally {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [
          RECONCILE_ADVISORY_LOCK_KEY,
        ]);
      }
    } finally {
      await lockRunner.release();
    }
  }

  private async sweepStuckTitles(): Promise<void> {
    // Cut on last_ingest_event_at, NOT updated_at: a view-count increment bumps
    // updated_at and would reset the clock on a title that is genuinely stuck
    // mid-ingest, hiding it from this sweep. Every in-flight title stamps
    // last_ingest_event_at on each transition (and when its upload is minted).
    const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
    const stuck = await this.titles.find({
      where: [
        {
          status: TitleStatus.AwaitingUpload,
          lastIngestEventAt: LessThan(cutoff),
        },
        {
          status: TitleStatus.Processing,
          lastIngestEventAt: LessThan(cutoff),
        },
        {
          pendingMuxUploadId: Not(IsNull()),
          lastIngestEventAt: LessThan(cutoff),
        },
        {
          pendingMuxAssetId: Not(IsNull()),
          lastIngestEventAt: LessThan(cutoff),
        },
      ],
    });
    for (const title of stuck) {
      try {
        await this.refreshTitleState(title);
      } catch (err) {
        // One unreachable title must not abort the sweep.
        this.logger.warn(
          `Reconciliation failed for title ${title.id}: ${String(err)}`,
        );
      }
    }
  }

  async refreshTitle(id: string): Promise<TitleDetail> {
    const title = await this.titles.findOne({ where: { id } });
    if (!title) {
      throw new NotFoundException('Title not found');
    }
    await this.refreshTitleState(title);
    const fresh = await this.titles.findOne({ where: { id } });
    return toTitleDetail(fresh ?? title, null, true);
  }

  // Polls Mux and feeds results through the same idempotent transition
  // methods the webhook uses — there is exactly one state machine.
  private async refreshTitleState(title: CinemaTitle): Promise<void> {
    // Main upload waiting on its asset.
    if (title.muxUploadId && !title.muxAssetId) {
      const upload = await this.mux.getUpload(title.muxUploadId);
      if (upload.assetId) {
        await this.cinema.onUploadAssetCreated(
          title.muxUploadId,
          upload.assetId,
        );
        title.muxAssetId = upload.assetId; // continue into the asset check
      } else if (FAILED_UPLOAD_STATUSES.has(upload.status)) {
        await this.cinema.onUploadFailed(
          title.muxUploadId,
          `upload ${upload.status}`,
        );
        return;
      }
    }
    // Main asset not yet ready.
    if (title.muxAssetId && title.status !== TitleStatus.Ready) {
      const asset = await this.mux.getAsset(title.muxAssetId);
      if (asset.status === 'ready') {
        await this.cinema.onAssetReady(title.muxAssetId, {
          playbackId: asset.playbackId,
          durationSeconds: asset.durationSeconds,
          aspectRatio: asset.aspectRatio,
        });
      } else if (asset.status === 'errored') {
        await this.cinema.onAssetErrored(
          title.muxAssetId,
          asset.errorMessage ?? 'Asset errored',
        );
      }
    }
    // Pending replacement upload waiting on its asset.
    if (title.pendingMuxUploadId && !title.pendingMuxAssetId) {
      const upload = await this.mux.getUpload(title.pendingMuxUploadId);
      if (upload.assetId) {
        await this.cinema.onUploadAssetCreated(
          title.pendingMuxUploadId,
          upload.assetId,
        );
        title.pendingMuxAssetId = upload.assetId;
      } else if (FAILED_UPLOAD_STATUSES.has(upload.status)) {
        await this.cinema.onUploadFailed(
          title.pendingMuxUploadId,
          `upload ${upload.status}`,
        );
        return;
      }
    }
    // Pending replacement asset (swap happens in onAssetReady).
    if (title.pendingMuxAssetId) {
      const asset = await this.mux.getAsset(title.pendingMuxAssetId);
      if (asset.status === 'ready') {
        await this.cinema.onAssetReady(title.pendingMuxAssetId, {
          playbackId: asset.playbackId,
          durationSeconds: asset.durationSeconds,
          aspectRatio: asset.aspectRatio,
        });
      } else if (asset.status === 'errored') {
        await this.cinema.onAssetErrored(
          title.pendingMuxAssetId,
          asset.errorMessage ?? 'Asset errored',
        );
      }
    }
  }
}
