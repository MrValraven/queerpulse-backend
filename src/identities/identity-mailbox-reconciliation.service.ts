import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  IdentityMailboxSyncService,
  MailboxSweepPageResult,
} from './identity-mailbox-sync.service';

/**
 * Postgres advisory-lock key for the hourly mailbox reconciliation.
 *
 * Advisory locks share one global namespace across every session on the
 * database, so this value must stay unique in the codebase. The keys in use
 * elsewhere: `MIGRATION_LOCK_KEY` (481205733107400, also hard-coded in
 * `scripts/migration-preflight.mjs`), the cinema sweep's
 * `RECONCILE_ADVISORY_LOCK_KEY` (793640001), and the per-row transaction
 * locks keyed by `hashtext(...)`, which always fall inside the 32-bit range.
 * This key sits above that range, so no `hashtext` key can ever equal it.
 * Do not reuse it for another job.
 */
export const IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY = 793_640_002_000;

/** The totals one full reconciliation run logs. */
export interface MailboxReconciliationSummary {
  processedIdentityCount: number;
  failedIdentityCount: number;
  seatedMemberCount: number;
  endedSeatCount: number;
  pageCount: number;
}

/**
 * The hourly safety net behind the mailbox seat hooks.
 *
 * The paths that add or remove staff (a co-manager accepting, leaving or
 * being revoked, a persona co-owner joining, leaving or being removed, an
 * ownership transfer) each update `conversation_participants` inside their
 * own transaction. This sweep reconciles every non-profile mailbox against
 * its staff source once an hour as well, through
 * `IdentityMailboxSyncService.resyncNonProfileIdentitiesPage`, so a seat any
 * of those paths missed is closed within the hour.
 *
 * EACH MAILBOX IN ITS OWN TRANSACTION. The page function reconciles one
 * identity per transaction, reading the staff source under a FOR SHARE lock
 * (listing row then its seat rows, or the persona row) before it reads the
 * seats, so a staff change committing mid-run is never read half before and
 * half after. A failed identity rolls back its own writes, announces
 * nothing, and is counted in the summary; the run carries on. Live events
 * for an identity go out only after its transaction commits.
 *
 * ONE REPLICA AT A TIME. `@Cron` fires in every app replica, so the run takes
 * a session-level `pg_try_advisory_lock` on a DEDICATED `QueryRunner` (the
 * pattern `CinemaReconciliationService` documents): whoever wins sweeps,
 * everybody else returns at once. The lock and the runner are released in
 * `finally`, and a crashed process frees the lock when its connection drops.
 *
 * ONE RUN PER PROCESS. An in-process flag skips a tick that lands while the
 * previous run is still paging, so a slow sweep never overlaps itself.
 *
 * NEVER THROWS. `@nestjs/schedule` does not wrap handlers, so an escaping
 * rejection becomes an unhandledRejection (see
 * `AccountDeletionProcessorService.processDueDeletions`). Every failure is
 * logged and the next tick retries.
 */
@Injectable()
export class IdentityMailboxReconciliationService {
  private readonly logger = new Logger(
    IdentityMailboxReconciliationService.name,
  );

  private isReconciliationRunning = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailboxSync: IdentityMailboxSyncService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleHourlyReconciliation(): Promise<void> {
    if (this.isReconciliationRunning) {
      this.logger.debug(
        'Mailbox reconciliation skipped: the previous run is still going',
      );
      return;
    }
    this.isReconciliationRunning = true;
    try {
      await this.reconcileUnderClusterLock();
    } catch (error) {
      this.logger.error(
        `Mailbox reconciliation failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    } finally {
      this.isReconciliationRunning = false;
    }
  }

  /**
   * Pages through every non-profile identity until the sweep reports no more,
   * adding up what each page changed. Public so an operator script or a test
   * can drive one full run without the scheduler or the lock.
   */
  async reconcileAllMailboxes(): Promise<MailboxReconciliationSummary> {
    const summary: MailboxReconciliationSummary = {
      processedIdentityCount: 0,
      failedIdentityCount: 0,
      seatedMemberCount: 0,
      endedSeatCount: 0,
      pageCount: 0,
    };
    let afterIdentityId: string | null = null;
    for (;;) {
      // Annotated: the loop assigns the cursor from this result, and an
      // inferred type would be circular.
      const pageResult: MailboxSweepPageResult =
        await this.mailboxSync.resyncNonProfileIdentitiesPage(afterIdentityId);
      summary.pageCount += 1;
      summary.processedIdentityCount += pageResult.processedIdentityCount;
      summary.failedIdentityCount += pageResult.failedIdentityCount;
      summary.seatedMemberCount += pageResult.seatedMemberCount;
      summary.endedSeatCount += pageResult.endedSeatCount;
      // The cursor must move forward for the loop to continue. Keyset paging
      // on `id` always advances it; the check guards the loop against a
      // result that ever breaks that rule.
      const hasCursorAdvanced =
        pageResult.lastIdentityId !== null &&
        pageResult.lastIdentityId !== afterIdentityId;
      if (!pageResult.hasMoreIdentities || !hasCursorAdvanced) {
        return summary;
      }
      afterIdentityId = pageResult.lastIdentityId;
    }
  }

  private async reconcileUnderClusterLock(): Promise<void> {
    const lockRunner = this.dataSource.createQueryRunner();
    try {
      await lockRunner.connect();
      // `QueryRunner.query` is untyped, hence the assertion.
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        // The expected outcome on every replica but one.
        this.logger.debug(
          'Mailbox reconciliation skipped: another replica holds the sweep lock',
        );
        return;
      }
      try {
        const summary = await this.reconcileAllMailboxes();
        this.logger.log(
          `Mailbox reconciliation: ${summary.processedIdentityCount} identities processed, ` +
            `${summary.seatedMemberCount} members seated, ` +
            `${summary.endedSeatCount} seats ended, ` +
            `${summary.failedIdentityCount} failures`,
        );
      } finally {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [
          IDENTITY_MAILBOX_RECONCILIATION_LOCK_KEY,
        ]);
      }
    } finally {
      await lockRunner.release();
    }
  }
}
