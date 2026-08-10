import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `reading_group_proposal` an admin decision lifecycle, backing the new
 * approve/decline/archive endpoints on `AdminReadingGroupProposalsController`.
 * Before this the admin oversight page was read-only (PLATFORM-GAPS item P3-6):
 * staff could see proposals but not act on them.
 *
 * Adds:
 *   - `status`        — a fresh enum (`pending|approved|declined|archived`),
 *                       NOT NULL DEFAULT 'pending'. Existing rows backfill to
 *                       'pending' via the column default, which is exactly the
 *                       state they are in (never decided).
 *   - `decided_at`    — when the current status was decided (null while pending).
 *   - `decided_by`    — the deciding admin/moderator (`users.id`), null while
 *                       pending. No FK on purpose: a decision is history that
 *                       must outlive a staff account's deletion (same rationale
 *                       as `deletion_request` keeping no user FK).
 *   - `decision_note` — optional free-text note attached to the decision.
 *
 * A brand-new `CREATE TYPE` (not `ALTER TYPE ... ADD VALUE`) so it is safe in
 * the single all-migrations transaction — the type and its first use are
 * different objects, so none of the "unsafe use of new enum value in the same
 * transaction" restriction applies here.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddReadingGroupProposalStatus1786000600000 implements MigrationInterface {
  name = 'AddReadingGroupProposalStatus1786000600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "reading_group_proposal_status_enum" AS ENUM (
        'pending', 'approved', 'declined', 'archived'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "reading_group_proposal"
        ADD COLUMN "status" "reading_group_proposal_status_enum"
          NOT NULL DEFAULT 'pending'
    `);
    await queryRunner.query(`
      ALTER TABLE "reading_group_proposal"
        ADD COLUMN "decided_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "reading_group_proposal"
        ADD COLUMN "decided_by" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "reading_group_proposal"
        ADD COLUMN "decision_note" character varying(500)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "decision_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "decided_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "decided_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reading_group_proposal" DROP COLUMN "status"`,
    );
    await queryRunner.query(`DROP TYPE "reading_group_proposal_status_enum"`);
  }
}
