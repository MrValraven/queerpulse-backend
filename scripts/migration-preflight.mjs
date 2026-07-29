// Deploy preflight: drop any INVALID Postgres indexes before migrations run.
// Runs as the step BEFORE `migration:run:prod` in the deploy chain:
//
//   docker run ... npm run migration:preflight
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
import { readFileSync } from 'node:fs';
import pg from 'pg';

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
try {
  // Invalid indexes across all non-system schemas. `pg_index.indisvalid = false`
  // is exactly the "failed/interrupted build" state; we also skip anything
  // still being built by a concurrent session (`indisready = false` while a
  // build is in progress) to avoid racing a legitimately-running CREATE INDEX
  // CONCURRENTLY — though during a deploy this script is the only DDL running.
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
  await client.end();
}
