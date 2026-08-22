import type { LoggerService } from '@nestjs/common';
import { DataSource, MigrationExecutor } from 'typeorm';

/** Env escape hatch: boot anyway, with the drift logged. */
const OVERRIDE_ENV = 'ALLOW_PENDING_MIGRATIONS';

/**
 * Refuse to serve traffic on a schema that is behind the code.
 *
 * Migrations are applied by `railway.json`'s `preDeployCommand`, in a step that
 * runs to completion before this process starts. Nothing verified that it
 * actually did. When a batch aborted part-way (which it can:
 * `src/data-source.ts` sets `migrationsTransactionMode: 'each'`, so a batch is
 * NOT atomic across migrations and a failure leaves the earlier ones applied and
 * the rest pending) the app started regardless and served requests against a
 * half-migrated database.
 *
 * That failure is invisible until traffic finds it, and then it is unreadable.
 * A single missing column on `users` surfaces as a 500 from whichever route
 * happens to load a `User` first, with a driver-level `QueryFailedError: column
 * user.<x> does not exist`, several layers away from the migration that never
 * ran. Sign-in is usually the one that finds it, because
 * `AuthService.validateOrCreateGoogleUser` hydrates the full entity on every
 * attempt.
 *
 * Failing at boot converts that into the failure the deploy should have had:
 * the healthcheck (`/health/live`) never comes up, the orchestrator marks the
 * rollout failed and keeps the previous version serving, and the log line names
 * the pending migrations. A schema-ahead-of-code state (extra columns, an
 * already-applied migration this build does not carry) is unaffected: only
 * migrations this build knows about and the database has not recorded count.
 *
 * Enforced in production only. Outside production the same drift is a warning,
 * since a developer with a stale database wants a hint rather than a service
 * that will not start. `ALLOW_PENDING_MIGRATIONS=true` downgrades it to a
 * warning everywhere, for the operator who has decided a specific pending
 * migration is safe to run behind live traffic.
 */
export async function assertNoPendingMigrations(
  dataSource: DataSource,
  options: { isProd: boolean; logger: LoggerService },
): Promise<void> {
  const { isProd, logger } = options;
  const context = 'MigrationCheck';

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

  if (!isProd || process.env[OVERRIDE_ENV] === 'true') {
    logger.warn(
      `${summary} Run \`pnpm run migration:run\` (or ` +
        `\`migration:run:prod\` against the deployed build).`,
      context,
    );
    return;
  }

  logger.error(
    `${summary} Refusing to start: serving on a half-migrated schema fails ` +
      `as unrelated 500s rather than as a failed deploy. Apply the pending ` +
      `migrations (the deploy's pre-deploy step is where this normally ` +
      `happens) and redeploy. Set ${OVERRIDE_ENV}=true to start anyway.`,
    context,
  );
  throw new Error(summary);
}
