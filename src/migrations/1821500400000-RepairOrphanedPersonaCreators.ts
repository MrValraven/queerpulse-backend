// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  readRepairOrphanedPersonaCreatorsTally,
  REPAIR_ORPHANED_PERSONA_CREATORS_SQL,
} from '../database/repair-orphaned-persona-creators.sql';

/**
 * One-off repair: hands every orphaned persona to a remaining co-owner.
 *
 * An orphaned persona is one whose creator (`subprofiles.user_id`) has no
 * `subprofile_members` row while at least one other member does. Before the
 * creator handoff shipped, a creator could leave a shared persona and keep the
 * creator column, so the persona went on nesting under the profile of someone
 * who no longer owned it, and every creator-only gate kept answering for them.
 *
 * The repair itself is {@link REPAIR_ORPHANED_PERSONA_CREATORS_SQL}, one DO
 * statement kept in `src/database/repair-orphaned-persona-creators.sql.ts` so
 * that this migration, its pending rerun
 * (`src/database/pending-migrations/1821700000000-RerunRepairOrphanedPersonaCreators.ts`,
 * which catches personas orphaned during the deploy window) and the
 * real-Postgres spec all run the same text. That file documents each step:
 * successor by active account first, then `joined_at` and `id`; the
 * `subprofile_create` advisory lock and slug suffix; a history row for a
 * Linked persona only; the `user_id` / `slug` / `updated_at` move; the
 * takedown copy on a renamed slug; and the skip of a persona whose last
 * member was erased mid-run.
 *
 * Mailbox seats are left to `IdentityMailboxReconciliationService`. Persona
 * staff is the roster alone (`IdentitiesService.subprofileStaff` counts the
 * creator only while they hold a member row), so an orphaned former creator
 * is already non-staff, and the hourly sweep, which visits every identity
 * holding a seat row, ends their leftover seats. The successor is already
 * seated as a member; their account switcher shows them as owner on its next
 * load, because the repair emits no staffing change. No notification is
 * sent: the change happened in the past, and a notice now would name an
 * event nobody saw.
 *
 * Runs in the default per-migration transaction, which the counts rely on:
 * the repair leaves them in a transaction-local setting that `up()` reads
 * back and logs. The persona rows stay locked FOR UPDATE until commit, so a
 * leave or accept on the previous release waits for it. A concurrent account
 * erasure can, rarely, deadlock with it (the erasure holds the user row and
 * waits on a locked persona while the history insert waits on that user
 * row); if Postgres aborts the migration, rerunning it finishes the repair.
 * It depends on `AddSubprofileAddressHistory1821500200000`.
 */
export class RepairOrphanedPersonaCreators1821500400000 implements MigrationInterface {
  name = 'RepairOrphanedPersonaCreators1821500400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(REPAIR_ORPHANED_PERSONA_CREATORS_SQL);
    const tally = await readRepairOrphanedPersonaCreatorsTally(queryRunner);

    // Deliberately loud: the one record of how many personas changed hands.
    console.log(
      `[RepairOrphanedPersonaCreators] ${JSON.stringify(tally, null, 2)}`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: RepairOrphanedPersonaCreators moved personas to a ' +
        'remaining co-owner and may have suffixed their slugs. The previous ' +
        'creators had already left, so there is no prior state worth ' +
        'restoring. Restore from a backup if one is truly needed.',
    );
  }
}
