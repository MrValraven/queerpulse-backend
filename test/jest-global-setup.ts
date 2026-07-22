import { setupTestEnv } from './db-safety';

/**
 * Jest `globalSetup`: runs once, before any suite/worker boots. Fails the whole
 * run fast (with a clear message) if the target database is not a test DB, so a
 * misconfigured DATABASE_URL can never reach a destructive suite.
 */
export default function globalSetup(): void {
  const dbName = setupTestEnv();

  console.log(`\n[e2e] Verified test database "${dbName}".\n`);
}
