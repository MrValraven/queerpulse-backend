import type { QueryRunner } from 'typeorm';

/**
 * The one Postgres advisory lock that serialises every process allowed to touch
 * the migration ledger or the indexes migrations build.
 *
 * WHY A FIXED NUMBER. An advisory lock is just an agreed-upon integer: two
 * processes only exclude each other if they pick the same one. Everything that
 * migrates this database therefore takes THIS key and no other:
 *
 *  - the boot-time catch-up run (apply-pending-migrations.ts), which also does
 *    the invalid-index sweep and the ledger rename pass under it;
 *  - the pre-deploy ledger reconcile
 *    (reconcile-renamed-migrations-cli.ts, `npm run migration:reconcile:prod`);
 *  - the pre-deploy invalid-index sweep (scripts/migration-preflight.mjs).
 *
 * That last one is a standalone `.mjs` and cannot import this module (it runs
 * without a compiled `dist/`, the same convention set-bucket-cors.mjs follows),
 * so it carries the number as a literal with a comment pointing back here. If
 * this constant ever changes, change it there in the same commit or the two
 * stop excluding each other and nothing says so.
 *
 * WHY SESSION SCOPE. `pg_try_advisory_lock` binds the lock to the SESSION that
 * took it, so a crashed or killed process releases it when its connection dies
 * and there is no stale-lock cleanup to write. The transaction-scoped variant
 * (`pg_advisory_xact_lock`) is unusable here: `DROP INDEX CONCURRENTLY` and
 * `CREATE INDEX CONCURRENTLY` are both forbidden inside a transaction block, so
 * the work these callers protect cannot be wrapped in the transaction such a
 * lock would need. The cost of session scope is that the lock must be released
 * on the SAME connection that took it, which is why every caller holds a
 * dedicated query runner rather than borrowing one from a pool per statement.
 */
export const MIGRATION_LOCK_KEY = 481_205_733_107_400;

/** How long a waiting process keeps polling before it gives up and fails. */
export const MIGRATION_LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Poll interval while another process holds the lock. */
export const MIGRATION_LOCK_POLL_INTERVAL_MS = 2_000;

/**
 * One non-blocking attempt at the lock. Callers poll this rather than blocking
 * in `pg_advisory_lock` so the wait can be bounded, logged, and cut short once
 * the caller decides there is nothing left to do.
 */
export async function tryTakeMigrationLock(
  queryRunner: QueryRunner,
): Promise<boolean> {
  const rows = (await queryRunner.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [MIGRATION_LOCK_KEY],
  )) as Array<{ locked: boolean }>;
  return rows[0]?.locked === true;
}

/**
 * Release the lock. Must run on the connection that took it; releasing from any
 * other session is a no-op that Postgres only reports as a warning.
 */
export async function releaseMigrationLock(
  queryRunner: QueryRunner,
): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_unlock($1)', [
    MIGRATION_LOCK_KEY,
  ]);
}
