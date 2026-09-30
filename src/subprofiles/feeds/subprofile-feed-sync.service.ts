import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { runWithConcurrency } from '../../common/run-with-concurrency';
import { isFeatureLaunched } from '../../launchedFeatures';
import { SubprofileFeed } from '../entities/subprofile-feed.entity';
import { SubprofileFeedsService } from './subprofile-feeds.service';

/**
 * Postgres advisory-lock key for the feed sweep. Advisory locks share ONE
 * global namespace across every session on the database, so this must differ
 * from every other key in `src/`: the cinema reconciliation (793640001), the
 * identity mailbox reconciliation (793_640_002_000) and Go together's matching
 * and retention runs (793_640_003_000 / 793_640_003_001).
 */
export const FEED_SYNC_LOCK_KEY = 793_640_004_000;

/** Feeds checked per run; the rest wait for the next tick. */
export const FEED_SYNC_BATCH_SIZE = 200;
/** Feeds fetched at once. Each holds an outbound socket and, while it writes,
 *  a pool connection, so this stays well under `DATABASE_POOL_MAX`. */
export const FEED_SYNC_CONCURRENCY = 4;

/**
 * Re-checks connected podcast feeds whose `next_check_at` has passed (persona
 * feed import). A healthy feed comes due every three hours; a failing one
 * backs off up to 48 hours (`feed-schedule.ts`).
 *
 * `@Cron` fires in EVERY replica, so the sweep is held to one of them by a
 * session-level `pg_try_advisory_lock` on a DEDICATED `QueryRunner`, the
 * pattern `CinemaReconciliationService` documents: the unlock must land on
 * the connection that took the lock, and a crash mid-sweep frees it when that
 * connection drops.
 */
@Injectable()
export class SubprofileFeedSyncService {
  private readonly logger = new Logger(SubprofileFeedSyncService.name);

  constructor(
    @InjectRepository(SubprofileFeed)
    private readonly feeds: Repository<SubprofileFeed>,
    private readonly feedsService: SubprofileFeedsService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncDueFeeds(): Promise<void> {
    if (!isFeatureLaunched('personaFeedImport')) return;
    const lockRunner = this.dataSource.createQueryRunner();
    await lockRunner.connect();
    try {
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [FEED_SYNC_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Feed sync skipped: another replica holds the sweep lock',
        );
        return;
      }
      try {
        await this.sweep(new Date());
      } finally {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [
          FEED_SYNC_LOCK_KEY,
        ]);
      }
    } finally {
      await lockRunner.release();
    }
  }

  /** One pass over the feeds due at `now`, oldest-due first. */
  async sweep(now: Date): Promise<number> {
    const due = await this.feeds.find({
      where: { nextCheckAt: LessThanOrEqual(now) },
      order: { nextCheckAt: 'ASC' },
      take: FEED_SYNC_BATCH_SIZE,
    });
    // THUNKS, never started promises: a started promise has already opened
    // its socket before `runWithConcurrency` sees it, defeating the cap. Each
    // catches its own failure so one broken feed never stops the sweep.
    await runWithConcurrency(
      due.map((feed) => async () => {
        try {
          await this.feedsService.syncFeed(feed, { kind: 'scheduled' });
        } catch (error) {
          this.logger.warn(`Feed sync failed for ${feed.id}: ${String(error)}`);
        }
      }),
      FEED_SYNC_CONCURRENCY,
    );
    return due.length;
  }
}
