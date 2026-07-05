import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(__dirname, '..');

/**
 * Load environment for e2e runs. `.env.test` wins; `.env` only fills in shared
 * defaults (secrets, Google/Mux creds) that the test file does not override —
 * dotenv never overwrites an already-set variable. If `TEST_DATABASE_URL` is
 * provided it becomes the effective `DATABASE_URL`, so the app and the tests
 * talk to the same dedicated test database.
 */
export function loadTestEnv(): void {
  loadEnv({ path: resolve(PROJECT_ROOT, '.env.test') });
  loadEnv({ path: resolve(PROJECT_ROOT, '.env') });
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
}

/**
 * Refuse to run the destructive e2e suites against a non-test database.
 *
 * The e2e specs TRUNCATE/DELETE every table between tests, so pointing them at
 * a dev or production DB would wipe real data. This guard throws unless either:
 *   - the target database name ends in `_test`, or
 *   - a dedicated `TEST_DATABASE_URL` was explicitly provided.
 *
 * @returns the verified database name (for logging).
 */
export function assertTestDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[e2e safety] DATABASE_URL is not set. Create a .env.test (see .env.test.example) ' +
        'pointing at a *_test database, or export TEST_DATABASE_URL.',
    );
  }

  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`[e2e safety] DATABASE_URL is not a valid URL: ${url}`);
  }

  const explicitTestUrl = Boolean(process.env.TEST_DATABASE_URL);
  if (!explicitTestUrl && !dbName.endsWith('_test')) {
    throw new Error(
      `[e2e safety] Refusing to run destructive e2e tests against database "${dbName}". ` +
        'These suites DELETE every table between tests. Point DATABASE_URL at a database ' +
        'whose name ends in "_test", or set a dedicated TEST_DATABASE_URL. See .env.test.example.',
    );
  }

  return dbName;
}

/** Load the test env and assert the target DB is safe. Returns the DB name. */
export function setupTestEnv(): string {
  loadTestEnv();
  return assertTestDatabase();
}
