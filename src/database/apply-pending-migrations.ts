import type { LoggerService } from '@nestjs/common';
import { DataSource, MigrationExecutor, type QueryRunner } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { reconcileRenamedMigrations } from './renamed-migrations';

const CONTEXT = 'MigrationRunner';

/**
 * Postgres advisory-lock key. Arbitrary but FIXED: every instance of this app
 * must pick the same number or the lock does not serialize anything. Session-
 * scoped (`pg_try_advisory_lock`), so a crashed instance releases it when its
 * connection dies, so there is no stale-lock cleanup to write.
 */
const MIGRATION_LOCK_KEY = 481_205_733_107_400;

/** How long a waiting instance keeps polling before it gives up and fails. */
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Poll interval while another instance holds the lock. */
const LOCK_POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type LockOutcome = 'acquired' | 'applied-elsewhere' | 'timed-out';

/**
 * Apply every migration this build carries that the database has not recorded.
 *
 * Called from bootstrap when the schema is behind the code (see
 * ensure-database-schema.ts). The deploy's `preDeployCommand` is still the
 * normal place migrations get applied; this is the path for when that step did
 * not run, did not finish, or does not exist in this environment. The app
 * catches the database up itself instead of refusing to start.
 *
 * Four things make that safe to do at boot:
 *
 *  1. A Postgres ADVISORY LOCK. Two instances rolling out at once would
 *     otherwise both start the same batch; the second would hit "relation
 *     already exists" half-way and crash-loop. Only the lock holder runs
 *     migrations; everyone else waits and re-checks, and finds nothing pending
 *     once the holder is done.
 *
 *  2. An INVALID-INDEX SWEEP, the same one `scripts/migration-preflight.mjs`
 *     does before `migration:run:prod`. An interrupted `CREATE INDEX
 *     CONCURRENTLY` leaves a non-functional index stub occupying the name
 *     without being recorded in the ledger, so the retry fails with "already
 *     exists" forever. Dropping the stub first makes the retry rebuild it.
 *
 *  3. A LEDGER RENAME PASS. A migration renumbered after it shipped is recorded
 *     under a class name no build carries any more, so it reads as pending and
 *     re-runs its `up()` against a schema that already has the change. Renaming
 *     the ledger row is the fix; `IF NOT EXISTS` guards on the DDL are not (see
 *     CLAUDE.md). See renamed-migrations.ts.
 *
 *  4. A SEPARATE DATA SOURCE for the run. The app's pool sets
 *     `statement_timeout` (30s by default) on every connection it opens, which
 *     is correct for serving traffic and wrong for a backfill or an index
 *     build, where a migration would be killed mid-way. This one clears the
 *     timeouts, holds a single connection, and uses
 *     `migrationsTransactionMode: 'each'` to match `src/data-source.ts`, which
 *     is what lets the `transaction = false` (CONCURRENTLY) migrations opt out.
 *
 * A migration that FAILS still aborts the boot. Serving on a half-migrated
 * schema is the thing this whole path exists to prevent; the failure surfaces
 * as a failed healthcheck naming the migration, and the orchestrator keeps the
 * previous version serving.
 */
export async function applyPendingMigrations(
  dataSource: DataSource,
  options: { logger: LoggerService },
): Promise<void> {
  const { logger } = options;

  // The lock lives on its own connection from the app pool, because an
  // advisory lock is bound to the SESSION that took it, so issuing the unlock
  // on a different pooled connection would silently do nothing. Held for the
  // whole run, released in `finally`.
  const lockRunner = dataSource.createQueryRunner();
  await lockRunner.connect();

  let isLockHeld = false;
  try {
    const outcome = await acquireMigrationLock(dataSource, lockRunner, logger);
    if (outcome === 'applied-elsewhere') {
      logger.log(
        'Another instance applied the pending migrations while this one waited.',
        CONTEXT,
      );
      return;
    }
    if (outcome === 'timed-out') {
      throw new Error(
        `Timed out after ${Math.round(LOCK_WAIT_TIMEOUT_MS / 1000)}s waiting ` +
          'for another instance to finish applying migrations. Refusing to ' +
          'start on a schema that is still behind this build.',
      );
    }
    isLockHeld = true;

    // Before anything is judged pending: bring ledger rows recorded under a
    // superseded class name up to the name this build carries. A migration that
    // was renumbered after it shipped is otherwise indistinguishable from one
    // that never ran, and re-running it fails on the change it already made.
    const renamedCount = await reconcileRenamedMigrations(lockRunner, logger);

    // Re-read the ledger now that the lock is held and the renames are settled:
    // the instance that just released it may have applied everything.
    const pending = await new MigrationExecutor(
      dataSource,
    ).getPendingMigrations();
    if (pending.length === 0) {
      logger.log(
        renamedCount > 0
          ? 'Nothing left to apply: the drift was renamed ledger rows, now ' +
              'reconciled.'
          : 'Pending migrations were applied by another instance; nothing to do.',
        CONTEXT,
      );
      return;
    }

    logger.log(
      `Applying ${pending.length} pending migration(s): ` +
        `${pending.map((migration) => migration.name).join(', ')}.`,
      CONTEXT,
    );

    const migrationDataSource = buildMigrationDataSource(dataSource);
    await migrationDataSource.initialize();
    try {
      // On the migration data source, not the pooled one: dropping an index
      // can block behind a conflicting transaction, and the app pool's
      // `statement_timeout` would cancel it mid-wait.
      await dropInvalidIndexes(migrationDataSource, logger);
      const applied = await migrationDataSource.runMigrations({
        transaction: 'each',
      });
      logger.log(
        `Applied ${applied.length} migration(s): ` +
          `${applied.map((migration) => migration.name).join(', ')}.`,
        CONTEXT,
      );
    } finally {
      await migrationDataSource.destroy();
    }
  } finally {
    if (isLockHeld) {
      try {
        await lockRunner.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_LOCK_KEY,
        ]);
      } catch (error) {
        // Losing the unlock is not fatal (the lock dies with the session), so
        // it must not mask whatever error is already unwinding.
        logger.warn(
          `Failed to release the migration advisory lock: ${String(error)}`,
          CONTEXT,
        );
      }
    }
    await lockRunner.release();
  }
}

/**
 * Take the advisory lock, or wait for whoever holds it. Polls rather than
 * blocking in `pg_advisory_lock` so the wait can be bounded, logged, and cut
 * short the moment the ledger says there is nothing left to apply.
 */
async function acquireMigrationLock(
  dataSource: DataSource,
  lockRunner: QueryRunner,
  logger: LoggerService,
): Promise<LockOutcome> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let hasLoggedWait = false;

  for (;;) {
    const rows = (await lockRunner.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MIGRATION_LOCK_KEY],
    )) as Array<{ locked: boolean }>;
    if (rows[0]?.locked) return 'acquired';

    const pending = await new MigrationExecutor(
      dataSource,
    ).getPendingMigrations();
    if (pending.length === 0) return 'applied-elsewhere';

    if (Date.now() >= deadline) return 'timed-out';

    if (!hasLoggedWait) {
      hasLoggedWait = true;
      logger.log(
        'Another instance is applying migrations; waiting for it to finish.',
        CONTEXT,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

/**
 * Drop indexes Postgres has marked INVALID, the debris of an interrupted
 * `CREATE INDEX CONCURRENTLY`. Mirrors `scripts/migration-preflight.mjs`; see
 * that file's header for why the migrations cannot use `IF NOT EXISTS` to
 * tolerate them instead. A valid index is never touched, so this is a no-op on
 * a healthy database.
 */
async function dropInvalidIndexes(
  migrationDataSource: DataSource,
  logger: LoggerService,
): Promise<void> {
  const invalidIndexes = await migrationDataSource.query<
    Array<{ schema: string; index_name: string }>
  >(`
    SELECT n.nspname AS schema, c.relname AS index_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.indisvalid = false
      AND i.indisready = true
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  `);

  if (invalidIndexes.length === 0) return;

  logger.warn(
    `Dropping ${invalidIndexes.length} invalid index(es) left by an ` +
      'interrupted CONCURRENTLY build: ' +
      invalidIndexes
        .map((index) => `${index.schema}.${index.index_name}`)
        .join(', '),
    CONTEXT,
  );
  for (const index of invalidIndexes) {
    // DROP ... CONCURRENTLY cannot run inside a transaction block; nothing here
    // opens one, so the connection is in autocommit. Both identifiers are
    // quoted to survive mixed-case names.
    await migrationDataSource.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "${index.schema}"."${index.index_name}"`,
    );
  }
}

/**
 * A short-lived DataSource for the migration run itself, cloned from the app's
 * connection options with the parts that are wrong for DDL replaced:
 *
 *  - `statement_timeout` / `idle_in_transaction_session_timeout` cleared, so a
 *    long backfill or index build is not killed by the pool's serving-traffic
 *    limits.
 *  - a pool of ONE, since migrations run strictly in sequence.
 *  - `migrationsTransactionMode: 'each'`, matching src/data-source.ts: the
 *    only mode in which a migration can set `transaction = false` for
 *    `CREATE INDEX CONCURRENTLY`.
 *  - no entities: migrations only ever touch the query runner, so building
 *    entity metadata a second time would be pure startup cost.
 */
function buildMigrationDataSource(dataSource: DataSource): DataSource {
  const baseOptions = dataSource.options as PostgresConnectionOptions;
  const baseExtra = (baseOptions.extra ?? {}) as Record<string, unknown>;

  return new DataSource({
    ...baseOptions,
    entities: [],
    subscribers: [],
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'each',
    logging: ['error', 'warn', 'migration', 'schema'],
    maxQueryExecutionTime: undefined,
    extra: {
      ...baseExtra,
      max: 1,
      min: 0,
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 0,
    },
  });
}
