import type { LoggerService } from '@nestjs/common';
import dataSource from '../data-source';
import {
  MIGRATION_LOCK_POLL_INTERVAL_MS,
  MIGRATION_LOCK_WAIT_TIMEOUT_MS,
  releaseMigrationLock,
  tryTakeMigrationLock,
} from './migration-lock';
import { reconcileRenamedMigrations } from './renamed-migrations';

/**
 * Deploy step: repair migration-ledger rows recorded under a superseded class
 * name, BEFORE the stock TypeORM CLI gets to look at them.
 *
 * WHY THIS EXISTS AS ITS OWN ENTRYPOINT. `reconcileRenamedMigrations()` was only
 * ever called from the boot path (apply-pending-migrations.ts), and boot is too
 * late. `railway.json`'s `preDeployCommand` applies migrations with
 * `migration:run:prod`, which is the stock `typeorm migration:run` and knows
 * nothing about renamed rows. A database still holding the seven superseded
 * names (see renamed-migrations.ts) reads as seven pending migrations to that
 * command, so it re-runs `1794700000000-AddTopicArchivedAt`'s unguarded
 * `ALTER TABLE "topics" ADD "archived_at"`, fails with "column already exists",
 * and takes the whole pre-deploy chain down. The code that would have healed the
 * ledger never gets to run, because the app never starts. Worse, an operator who
 * forces past that failure hands `BackfillCollectionsIntoSavedLists` a second
 * run, which resurrects saved lists members have deliberately deleted and
 * re-files items they removed.
 *
 * So the repair moves ahead of the CLI in the chain, as
 * `npm run migration:reconcile:prod`. It reuses the app's own data source
 * (src/data-source.ts) rather than a hand-rolled connection, so TLS is
 * negotiated exactly as `migration:run:prod` and the running app negotiate it.
 * The runtime image carries `dist/`, `node_modules` and `package.json` but NOT
 * `src/`, which is why this is a compiled entrypoint rather than another
 * `scripts/*.mjs`.
 *
 * The boot-time call stays where it is. It is what covers every environment that
 * has no pre-deploy step: `docker compose up`, a local `start:prod`, any host
 * that only runs the container's CMD.
 *
 * Idempotent, like every other step in the chain: it renames nothing on a
 * database that never held the old names, skips a row whose new name is already
 * present, and returns early on a database with no ledger table at all.
 */

const CONTEXT = 'MigrationReconcile';

/**
 * A LoggerService over `console`, because this runs outside the Nest container
 * and there is no injected logger to borrow. Matches the shape
 * `reconcileRenamedMigrations()` expects; the deploy log is plain text.
 */
const consoleLogger: LoggerService = {
  log: (message: unknown) => console.log(`[${CONTEXT}] ${String(message)}`),
  warn: (message: unknown) => console.warn(`[${CONTEXT}] ${String(message)}`),
  error: (message: unknown) => console.error(`[${CONTEXT}] ${String(message)}`),
};

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function reconcileUnderLock(): Promise<void> {
  await dataSource.initialize();
  // One dedicated connection for the whole step. The advisory lock is bound to
  // the SESSION that took it, so taking it on one connection and releasing it on
  // another would silently do nothing.
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();

  let isLockHeld = false;
  try {
    const deadline = Date.now() + MIGRATION_LOCK_WAIT_TIMEOUT_MS;
    let hasLoggedWait = false;
    // Poll rather than block in `pg_advisory_lock`, so the wait is bounded and
    // the deploy log says why the step is sitting there.
    while (!isLockHeld) {
      isLockHeld = await tryTakeMigrationLock(queryRunner);
      if (isLockHeld) break;

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(
            MIGRATION_LOCK_WAIT_TIMEOUT_MS / 1000,
          )}s waiting for another process to release the migration lock. ` +
            'Refusing to rewrite ledger rows underneath a migration run that ' +
            'is still in progress.',
        );
      }
      if (!hasLoggedWait) {
        hasLoggedWait = true;
        consoleLogger.log(
          'Another process holds the migration lock; waiting for it to finish.',
          CONTEXT,
        );
      }
      await sleep(MIGRATION_LOCK_POLL_INTERVAL_MS);
    }

    const renamedCount = await reconcileRenamedMigrations(
      queryRunner,
      consoleLogger,
    );
    consoleLogger.log(
      renamedCount === 0
        ? 'Migration ledger already carries the names this build uses; ' +
            'nothing to reconcile.'
        : `Reconciled ${renamedCount} migration ledger row(s) before the ` +
            'migration run.',
      CONTEXT,
    );
  } finally {
    if (isLockHeld) {
      try {
        await releaseMigrationLock(queryRunner);
      } catch (error) {
        // The lock dies with the session a moment from now, so failing to
        // release it is harmless and must not mask an error already unwinding.
        consoleLogger.warn(
          `Failed to release the migration advisory lock: ${String(error)}`,
          CONTEXT,
        );
      }
    }
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // No database configured in this environment, so there is no ledger to
    // repair. Exit cleanly so the step can sit unconditionally in the `&&`
    // deploy chain, the way migration-preflight.mjs and set-bucket-cors.mjs do.
    consoleLogger.log(
      'DATABASE_URL not set; skipping the migration ledger reconcile.',
      CONTEXT,
    );
    return;
  }
  await reconcileUnderLock();
}

void main().catch((error: unknown) => {
  consoleLogger.error(
    `Failed to reconcile renamed migration ledger rows: ${String(error)}. ` +
      'Stopping the deploy here: letting `migration:run:prod` run next would ' +
      're-apply migrations this database has already had.',
    CONTEXT,
  );
  process.exitCode = 1;
});
