import type { LoggerService } from '@nestjs/common';
import { DataSource, MigrationExecutor } from 'typeorm';
import { applyPendingMigrations } from './apply-pending-migrations';

/** Env escape hatch: do NOT apply migrations at boot, only report the drift. */
const AUTO_RUN_ENV = 'AUTO_RUN_MIGRATIONS';

/** Env escape hatch: with auto-run off, boot anyway with the drift logged. */
const OVERRIDE_ENV = 'ALLOW_PENDING_MIGRATIONS';

const CONTEXT = 'MigrationCheck';

/**
 * Make the database schema match this build before anything serves traffic.
 *
 * Migrations are normally applied by `railway.json`'s `preDeployCommand`, in a
 * step that runs to completion before this process starts. Nothing verified
 * that it actually did. When that step is missing, fails, or aborts part-way
 * (which it can: `src/data-source.ts` sets `migrationsTransactionMode: 'each'`,
 * so a batch is NOT atomic across migrations and a failure leaves the earlier
 * ones applied and the rest pending) the app used to start regardless and serve
 * requests against a half-migrated database.
 *
 * That failure is invisible until traffic finds it, and then it is unreadable.
 * A single missing column on `users` surfaces as a 500 from whichever route
 * happens to load a `User` first, with a driver-level `QueryFailedError: column
 * user.<x> does not exist`, several layers away from the migration that never
 * ran. Sign-in is usually the one that finds it, because
 * `AuthService.validateOrCreateGoogleUser` hydrates the full entity on every
 * attempt.
 *
 * So the boot path checks the ledger, and by default CATCHES THE DATABASE UP
 * itself, under an advisory lock, so a multi-instance rollout still applies
 * the batch exactly once. See apply-pending-migrations.ts. A schema AHEAD of
 * the code (extra columns, an already-applied migration this build does not
 * carry) is untouched: only migrations this build knows about and the database
 * has not recorded count.
 *
 * If applying them fails, that is a refusal to start in production: the
 * healthcheck (`/health/live`) never comes up, the orchestrator marks the
 * rollout failed and keeps the previous version serving, and the log names the
 * migration that broke. Outside production the same failure is a warning, since
 * a developer wants a hint rather than a service that will not start.
 *
 * Two env escape hatches, for the operator who wants the old behaviour:
 *  - `AUTO_RUN_MIGRATIONS=false`: never apply anything at boot; go back to
 *    reporting the drift (fatal in production, a warning elsewhere).
 *  - `ALLOW_PENDING_MIGRATIONS=true`: with auto-run off, downgrade that to a
 *    warning everywhere, for the operator who has decided a specific pending
 *    migration is safe to run behind live traffic.
 */
export async function ensureDatabaseSchema(
  dataSource: DataSource,
  options: { isProd: boolean; logger: LoggerService },
): Promise<void> {
  const { isProd, logger } = options;

  // Reads the `migrations` ledger and compares it against the migration classes
  // this build carries (the glob registered in database.module.ts). Nothing is
  // executed.
  const pending = await new MigrationExecutor(
    dataSource,
  ).getPendingMigrations();
  if (pending.length === 0) return;

  const names = pending.map((migration) => migration.name).join(', ');
  const summary =
    `Database schema is behind this build: ${pending.length} migration(s) ` +
    `pending (${names}).`;

  if (process.env[AUTO_RUN_ENV] === 'false') {
    reportWithoutApplying({ summary, isProd, logger });
    return;
  }

  logger.warn(`${summary} Applying them now.`, CONTEXT);

  try {
    await applyPendingMigrations(dataSource, { logger });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!isProd) {
      logger.error(
        `Failed to apply pending migrations: ${detail}. Continuing anyway ` +
          `because this is not production. Routes touching the un-migrated ` +
          `tables will fail. Run \`pnpm run migration:run\` and look at the ` +
          `error above.`,
        CONTEXT,
      );
      return;
    }
    logger.error(
      `Failed to apply pending migrations: ${detail}. Refusing to start: ` +
        `serving on a half-migrated schema fails as unrelated 500s rather ` +
        `than as a failed deploy.`,
      CONTEXT,
    );
    throw error;
  }
}

/** `AUTO_RUN_MIGRATIONS=false`: report the drift, fatally in production. */
function reportWithoutApplying(options: {
  summary: string;
  isProd: boolean;
  logger: LoggerService;
}): void {
  const { summary, isProd, logger } = options;

  if (!isProd || process.env[OVERRIDE_ENV] === 'true') {
    logger.warn(
      `${summary} Run \`pnpm run migration:run\` (or ` +
        `\`migration:run:prod\` against the deployed build).`,
      CONTEXT,
    );
    return;
  }

  logger.error(
    `${summary} Refusing to start (${AUTO_RUN_ENV}=false): serving on a ` +
      `half-migrated schema fails as unrelated 500s rather than as a failed ` +
      `deploy. Apply the pending migrations (the deploy's pre-deploy step is ` +
      `where this normally happens) and redeploy. Unset ${AUTO_RUN_ENV} to ` +
      `have the app apply them itself, or set ${OVERRIDE_ENV}=true to start ` +
      `anyway.`,
    CONTEXT,
  );
  throw new Error(summary);
}
