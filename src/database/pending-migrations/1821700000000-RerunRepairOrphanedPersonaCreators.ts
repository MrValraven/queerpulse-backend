// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
// Moving this file into `src/migrations` changes this path to
// '../database/repair-orphaned-persona-creators.sql' (see the README here).
import {
  readRepairOrphanedPersonaCreatorsTally,
  REPAIR_ORPHANED_PERSONA_CREATORS_SQL,
} from '../repair-orphaned-persona-creators.sql';

/**
 * Follow-up rerun of the orphaned-persona repair, for the release AFTER the
 * persona creator handoff ships.
 *
 * `RepairOrphanedPersonaCreators1821500400000` runs before the handoff
 * release takes traffic, while the previous release still serves it. Until
 * that previous release stops, it can orphan a persona again in two ways:
 * - a creator leaves a shared persona through the previous release's
 *   `leave()`, which keeps the creator column and deletes the creator's
 *   member row;
 * - an edit through the previous release's `update`, `publish` or
 *   `unpublish` loaded the persona before the repair committed and saves the
 *   whole entity after it, writing the pre-repair `user_id` and `slug` back
 *   over the successor.
 * Both leave the same shape the repair looks for: a creator with no member
 * row while other members exist. Once the handoff release is the only one
 * serving traffic, nothing can create that shape, so this single rerun
 * closes the window.
 *
 * Its `up()` is the same as `1821500400000`'s: it runs
 * {@link REPAIR_ORPHANED_PERSONA_CREATORS_SQL} (whose doc comment describes
 * each step) and logs the tally. It is idempotent: on a database with no
 * orphaned persona it changes nothing and logs zero counts. No notification
 * is sent, as for the first run. Mailbox seats follow on the next hourly
 * reconciliation sweep.
 *
 * Runs in the default per-migration transaction, which the counts rely on:
 * the repair leaves them in a transaction-local setting that `up()` reads
 * back. A concurrent account erasure can, rarely, deadlock with it; if
 * Postgres aborts the migration, rerunning it finishes the repair.
 */
export class RerunRepairOrphanedPersonaCreators1821700000000 implements MigrationInterface {
  name = 'RerunRepairOrphanedPersonaCreators1821700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(REPAIR_ORPHANED_PERSONA_CREATORS_SQL);
    const tally = await readRepairOrphanedPersonaCreatorsTally(queryRunner);

    // Deliberately loud: the one record of how many personas changed hands.
    console.log(
      `[RerunRepairOrphanedPersonaCreators] ${JSON.stringify(tally, null, 2)}`,
    );
  }

  public down(): Promise<void> {
    return Promise.reject(
      new Error(
        'Irreversible: RerunRepairOrphanedPersonaCreators moved personas to a ' +
          'remaining co-owner and may have suffixed their slugs. The previous ' +
          'creators had already left, so there is no prior state worth ' +
          'restoring. Restore from a backup if one is truly needed.',
      ),
    );
  }
}
