// Deploy preflight: drop any INVALID Postgres indexes before migrations run.
// Runs as the FIRST step of the deploy chain:
//
//   docker run ... npm run migration:preflight
//   docker run ... npm run migration:reconcile:prod
//   docker run ... npm run migration:run:prod
//   docker run ... npm run storage:cors
//
// Why this exists: some migrations build indexes with `CREATE INDEX
// CONCURRENTLY` and therefore run OUTSIDE a transaction (see
// src/data-source.ts `migrationsTransactionMode: 'each'` and the
// `transaction = false` migrations). A non-transactional index build that is
// interrupted — a killed deploy, a dropped DB connection, a statement timeout —
// leaves a *leftover INVALID index* behind, and is NOT recorded in the
// migrations ledger (its transaction never committed). Postgres never uses an
// invalid index to answer queries, but the stub still occupies the index name,
// so on the retry the migration's plain `CREATE INDEX CONCURRENTLY` fails with
// "already exists" and the deploy is wedged. Those migrations deliberately do
// NOT use `IF NOT EXISTS` to paper over this (forbidden repo-wide — it hides
// schema drift; see CLAUDE.md). Instead this preflight drops the invalid stub
// first, so the retry rebuilds it cleanly. An index that IS valid is never
// touched, so this is a no-op on a healthy database and safe to run every time.
//
// Re-running is safe: it only ever DROPs indexes Postgres has already marked
// invalid (i.e. non-functional), and does nothing when there are none.
//
// It holds the shared migration ADVISORY LOCK for the whole sweep. That is what
// makes the drop safe, rather than the catalog predicate below: a healthy
// `CREATE INDEX CONCURRENTLY` that is still running looks the same in `pg_index`
// as the debris of a dead one for almost all of its life, so nothing in the
// catalog distinguishes them. Taking the same lock the boot-time sweep and the
// migration run take means no two of this repo's index builders can ever be
// alive at once. See src/database/migration-lock.ts.
import { readFileSync } from 'node:fs';
import pg from 'pg';

// MUST MATCH `MIGRATION_LOCK_KEY` in src/database/migration-lock.ts. An advisory
// lock is just an agreed-upon integer: two processes only exclude each other if
// they pick the same one, and Postgres reports nothing when they do not. The
// number is duplicated rather than imported because this script deliberately
// runs standalone, without a compiled dist/ (the same convention the TLS
// resolution below and set-bucket-cors.mjs follow). Change it in both places or
// in neither.
const MIGRATION_LOCK_KEY = 481205733107400;

// How long to wait for whoever holds the lock (a boot-time catch-up run on the
// previous container, say) before giving up and failing the deploy step.
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_POLL_INTERVAL_MS = 2_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  // No database configured in this env — nothing to preflight. Exit cleanly so
  // the step can sit unconditionally in a `&&` deploy chain (mirrors
  // set-bucket-cors.mjs's skip-when-unconfigured behaviour).
  console.log('DATABASE_URL not set; skipping migration preflight.');
  process.exit(0);
}

// TLS resolution mirrors src/config/database-ssl.ts. It is re-implemented here
// (not imported) so this script runs standalone without a compiled dist/, the
// same convention set-bucket-cors.mjs follows. The app, the migration CLI, and
// this script MUST negotiate TLS identically or a step succeeds against a
// connection the app then cannot open — see database-ssl.ts's header.
function resolvePostgresSsl() {
  const explicit = process.env.DATABASE_SSL;
  const sslEnabled =
    explicit === 'true'
      ? true
      : explicit === 'false'
        ? false
        : process.env.NODE_ENV === 'production';

  if (!sslEnabled) return false;
  if (process.env.DATABASE_SSL_INSECURE === 'true') {
    return { rejectUnauthorized: false };
  }
  const ssl = { rejectUnauthorized: true };
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) {
    // Inline PEM is passed straight through; anything else is treated as a path.
    ssl.ca = ca.includes('BEGIN CERTIFICATE') ? ca : readFileSync(ca, 'utf8');
  }
  return ssl;
}

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: resolvePostgresSsl(),
});

await client.connect();
// Declared out here so the `finally` below knows whether there is anything to
// release: unlocking a lock this session never took only logs a Postgres
// WARNING, and a deploy log should not carry noise that reads like a fault.
let isLockHeld = false;
try {
  // Take the shared migration lock before looking at anything. It is SESSION
  // scoped (`pg_try_advisory_lock`), so it dies with this connection and needs
  // no stale-lock cleanup; the transaction-scoped variant is unusable here
  // because `DROP INDEX CONCURRENTLY` cannot run inside a transaction block at
  // all. Poll rather than block, so the wait is bounded and the deploy log says
  // why this step is sitting there.
  const lockDeadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let hasLoggedWait = false;
  while (!isLockHeld) {
    const { rows: lockRows } = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MIGRATION_LOCK_KEY],
    );
    isLockHeld = lockRows[0]?.locked === true;
    if (isLockHeld) break;

    if (Date.now() >= lockDeadline) {
      throw new Error(
        `Migration preflight timed out after ${Math.round(
          LOCK_WAIT_TIMEOUT_MS / 1000,
        )}s waiting for another process to release the migration lock. ` +
          'Refusing to drop indexes underneath a migration run that is still ' +
          'in progress.',
      );
    }
    if (!hasLoggedWait) {
      hasLoggedWait = true;
      console.log(
        'Migration preflight: another process holds the migration lock; waiting for it to finish.',
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }

  // Invalid indexes across all non-system schemas. `pg_index.indisvalid = false`
  // is exactly the "failed/interrupted build" state. `indisready = true` rules
  // out only the first moments of a build, when the catalog row exists but is
  // not yet receiving inserts; it does NOT rule out a healthy in-flight
  // CONCURRENTLY build, which sets `indisready = true` early and flips
  // `indisvalid = true` only at the very end. The advisory lock held above is
  // what actually keeps this from dropping an index another runner is building.
  // Kept identical to the sweep in src/database/apply-pending-migrations.ts:
  // the two must select the same rows or one of them heals a database the other
  // wedges.
  const { rows } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS index_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.indisvalid = false
      AND i.indisready = true
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname
  `);

  if (rows.length === 0) {
    console.log('Migration preflight: no invalid indexes found.');
  } else {
    console.log(
      `Migration preflight: dropping ${rows.length} invalid index(es) left by an interrupted CONCURRENTLY build:`,
    );
    for (const { schema, index_name: indexName } of rows) {
      console.log(`  - ${schema}.${indexName}`);
      // DROP ... CONCURRENTLY also cannot run in a transaction; the pg client
      // is in autocommit here (no BEGIN issued), so this is fine. Quote both
      // identifiers to survive mixed-case / reserved names.
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${indexName}"`,
      );
    }
    console.log('Migration preflight: done.');
  }
} finally {
  // The lock would die with the connection a line from now anyway; releasing it
  // explicitly keeps the intent readable and must never mask an error already
  // unwinding, hence the swallowed catch.
  if (isLockHeld) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      console.warn(
        `Migration preflight: failed to release the migration advisory lock: ${String(error)}`,
      );
    }
  }
  await client.end();
}
