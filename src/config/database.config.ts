import { registerAs } from '@nestjs/config';

/** Parse an optional integer env var, falling back to a default. */
function integerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** pg connection-pool + timeout tuning, resolved from validated env. */
export interface DatabasePoolConfig {
  max: number;
  min: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statementTimeoutMillis: number;
}

export default registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  // synchronize is NEVER true — schema is owned by migrations.
  synchronize: false as const,
  // TLS is NOT configured here. It lives in src/config/database-ssl.ts, which
  // both the app and the migration CLI import — the CLI has no Nest container,
  // so a ConfigService-only knob could not reach it, and the two drifted apart.
  //
  // pg pool + timeout tuning. Driven by env with production-safe defaults;
  // keeps a runaway query or a saturated pool from taking the app down.
  pool: {
    max: integerFromEnv(process.env.DATABASE_POOL_MAX, 10),
    min: integerFromEnv(process.env.DATABASE_POOL_MIN, 0),
    connectionTimeoutMillis: integerFromEnv(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS,
      10_000,
    ),
    idleTimeoutMillis: integerFromEnv(
      process.env.DATABASE_IDLE_TIMEOUT_MS,
      30_000,
    ),
    statementTimeoutMillis: integerFromEnv(
      process.env.DATABASE_STATEMENT_TIMEOUT_MS,
      30_000,
    ),
  } satisfies DatabasePoolConfig,
  // Slow-query visibility: TypeORM LOGS (does not kill) any query running
  // longer than this many ms, well ahead of the blanket `statement_timeout`
  // kill-switch above — the early warning this backend didn't have before
  // (no `maxQueryExecutionTime`/query `logging` was configured anywhere; the
  // only prior signal was a query surviving to the full 30s cutoff). See
  // `database-and-indexing.md` / `observability-and-resilience.md`.
  slowQueryThresholdMillis: integerFromEnv(
    process.env.DATABASE_SLOW_QUERY_THRESHOLD_MS,
    500,
  ),
}));
