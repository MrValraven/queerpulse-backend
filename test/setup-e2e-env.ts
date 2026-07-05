import { setupTestEnv } from './db-safety';

// `setupFiles` runs in every worker BEFORE the test framework and before any
// e2e spec (and therefore before AppModule / TypeORM is imported). This both
// loads the test environment into `process.env` for that worker and re-asserts
// the DB is a test DB, so the guard holds even if a worker is spawned with an
// unexpected environment. globalSetup gives the fast up-front failure; this
// makes the guarantee per-worker.
setupTestEnv();
