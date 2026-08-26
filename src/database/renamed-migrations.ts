import type { LoggerService } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

const CONTEXT = 'MigrationRename';

/**
 * TypeORM's ledger table. Not configurable anywhere in this app (neither
 * `src/data-source.ts` nor `database.module.ts` sets `migrationsTableName`), and
 * its `timestamp`/`name` columns are created by `MigrationExecutor` with fixed
 * identifiers, so `SnakeNamingStrategy` does not reach them.
 */
const LEDGER_TABLE = 'migrations';

interface RenamedMigration {
  /** The class `name` a previous deploy recorded in the ledger. */
  readonly previousName: string;
  /** The class `name` this build carries. */
  readonly currentName: string;
  /** The timestamp embedded in `currentName`, kept in sync by hand. */
  readonly currentTimestamp: number;
}

/**
 * Migrations whose class `name` changed AFTER a build carrying the old name had
 * already been deployed.
 *
 * WHY THIS LIST EXISTS. TypeORM identifies an applied migration solely by the
 * `name` string on its class, and that string embeds the file's timestamp. Renumber
 * a file and the ledger no longer recognises it: `getPendingMigrations()` reports
 * the new name as pending and re-runs `up()` against a schema that already has the
 * change. That is a hard boot failure, by design (see ensure-database-schema.ts),
 * and it reads as nonsense at the top of the log:
 *
 *     column "archived_at" of relation "topics" already exists
 *
 * WHAT HAPPENED ON 2026-08-26. Two parallel work streams picked the same
 * 1794700000000-1794740000000 timestamp band. The clash was first resolved by
 * moving seven of the colliding files up into a `...100000` band, and that build
 * reached production, which applied all seven and recorded the `...100000` names.
 * The clash was then resolved the other way instead: the seven were moved back to
 * their original `...000000` names and the duplicate timestamps were allowlisted in
 * `scripts/check-migration-timestamps.mjs`, which is the correct end state (a
 * duplicate timestamp between two migrations touching disjoint objects is harmless;
 * a renamed migration is not). Production was left holding seven ledger rows under
 * names no build carries any more.
 *
 * THE RULE THIS ENCODES. An applied migration's name is frozen history. When a
 * rename has nonetheless already shipped, the repair belongs in the LEDGER, never
 * in the migration body: re-running the seven is not an option, because
 * `1794740000000-BackfillCollectionsIntoSavedLists` would resurrect saved lists
 * members have since deleted and re-file items they removed, and `IF NOT EXISTS`
 * guards cannot express that.
 *
 * DO NOT ADD TO THIS LIST to make a fresh renumbering work. Give a NEW migration a
 * unique timestamp instead. Entries here are permanent: they must keep running for
 * as long as any database might still hold the old name.
 */
const RENAMED_MIGRATIONS: readonly RenamedMigration[] = [
  {
    previousName: 'AddTopicArchivedAt1794700100000',
    currentName: 'AddTopicArchivedAt1794700000000',
    currentTimestamp: 1794700000000,
  },
  {
    previousName: 'SeedTopics1794701100000',
    currentName: 'SeedTopics1794701000000',
    currentTimestamp: 1794701000000,
  },
  {
    previousName: 'CreateForumThreadSubscription1794710100000',
    currentName: 'CreateForumThreadSubscription1794710000000',
    currentTimestamp: 1794710000000,
  },
  {
    previousName: 'AddHousingModerationDecisionEnums1794720100000',
    currentName: 'AddHousingModerationDecisionEnums1794720000000',
    currentTimestamp: 1794720000000,
  },
  {
    previousName: 'AddSafeSpaceReviewWorkflow1794730100000',
    currentName: 'AddSafeSpaceReviewWorkflow1794730000000',
    currentTimestamp: 1794730000000,
  },
  {
    previousName: 'BackfillSafeSpaceNominationWorkflow1794731100000',
    currentName: 'BackfillSafeSpaceNominationWorkflow1794731000000',
    currentTimestamp: 1794731000000,
  },
  {
    previousName: 'BackfillCollectionsIntoSavedLists1794740100000',
    currentName: 'BackfillCollectionsIntoSavedLists1794740000000',
    currentTimestamp: 1794740000000,
  },
];

/**
 * Bring ledger rows recorded under a superseded class name up to the name this
 * build carries, so the migration they stand for stops looking pending.
 *
 * Runs at boot from apply-pending-migrations.ts, under the same advisory lock as
 * the migration run itself, before the pending set is computed. Renaming in place
 * rather than inserting a second row keeps the ledger a truthful history: one row
 * per migration that has actually run, no orphans under dead names.
 *
 * Safe to run on any database, repeatedly:
 *  - a database that never saw the old name matches nothing and is untouched;
 *  - a database that already carries the new name is skipped by the `NOT EXISTS`
 *    guard, so a row is never duplicated;
 *  - a database with no ledger table at all (a first-ever boot) returns early.
 *
 * @returns how many ledger rows were renamed, for the caller's log line.
 */
export async function reconcileRenamedMigrations(
  queryRunner: QueryRunner,
  logger: LoggerService,
): Promise<number> {
  const ledgerRows = (await queryRunner.query(
    `SELECT to_regclass($1) IS NOT NULL AS ledger_exists`,
    [LEDGER_TABLE],
  )) as Array<{ ledger_exists: boolean }>;
  // A database being migrated from empty has no ledger yet; MigrationExecutor
  // creates it moments later, and nothing in it can need renaming.
  if (!ledgerRows[0]?.ledger_exists) return 0;

  const renamed: string[] = [];
  for (const migration of RENAMED_MIGRATIONS) {
    // A raw `.query()` UPDATE resolves to [returnedRows, affectedCount], not to
    // rows, so the count is the SECOND element.
    const [, affectedCount] = (await queryRunner.query(
      `UPDATE "${LEDGER_TABLE}" AS ledger
          SET "timestamp" = $1, "name" = $2
        WHERE ledger."name" = $3
          AND NOT EXISTS (
            SELECT 1 FROM "${LEDGER_TABLE}" AS twin WHERE twin."name" = $2
          )`,
      [
        migration.currentTimestamp,
        migration.currentName,
        migration.previousName,
      ],
    )) as [unknown[], number];

    if (affectedCount > 0) {
      renamed.push(`${migration.previousName} -> ${migration.currentName}`);
    }
  }

  if (renamed.length > 0) {
    logger.warn(
      `Renamed ${renamed.length} migration ledger row(s) recorded under a ` +
        `superseded class name, so their migrations are not re-run against a ` +
        `schema that already has them: ${renamed.join(', ')}.`,
      CONTEXT,
    );
  }

  return renamed.length;
}
