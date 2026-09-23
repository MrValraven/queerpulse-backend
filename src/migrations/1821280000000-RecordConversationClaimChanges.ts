// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claim changes for shared business mailboxes (Task 19). Beside the current
 * claim (`claimed_by_user_id`, `claimed_at`, from
 * `1821250000000-AddConversationClaim.ts`) a thread now records the latest
 * change to it: `claim_released_by_user_id` and `claim_released_at` name who
 * last released the claim and when (spec 4.3), and
 * `claim_taken_over_from_user_id` names whose claim the current claimant
 * took over (spec 6.5). All three are NULL on every existing row.
 *
 * LATEST CHANGE ONLY. Every claim write (`ConversationsService.claim`,
 * `takeOver`, `release`) sets all five claim columns in one conditional
 * UPDATE, so the row never holds a mixed state. There is no history table:
 * the maintainer's rule is no behaviour analytics.
 *
 * LOCKS. All three new columns are nullable with no default, so each `ADD
 * COLUMN` is a metadata-only change on Postgres and takes no more than the
 * brief `ACCESS EXCLUSIVE` lock that statement always needs. `ADD
 * CONSTRAINT ... FOREIGN KEY` takes a `SHARE ROW EXCLUSIVE` lock on
 * `conversations` (reads proceed; concurrent writes to the table wait) while
 * it validates the new constraint, but every existing row is NULL in the
 * very column the constraint checks, so that validation scan finds nothing
 * to flag and finishes quickly even though `conversations` holds real
 * production data. No index is built here, so this migration keeps the
 * plain transactional shape `1821250000000-AddConversationClaim.ts` used for
 * the same kind of change on this same table. The partial indexes serving
 * the two `ON DELETE SET NULL` lookups are built `CONCURRENTLY` in the
 * separate, non-transactional
 * `1821280100000-IndexConversationClaimChangeUsers.ts`.
 */
export class RecordConversationClaimChanges1821280000000 implements MigrationInterface {
  name = 'RecordConversationClaimChanges1821280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "claim_released_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "claim_released_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "claim_taken_over_from_user_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_claim_released_by_user_id"
        FOREIGN KEY ("claim_released_by_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_claim_taken_over_from_user_id"
        FOREIGN KEY ("claim_taken_over_from_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_claim_taken_over_from_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_claim_released_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "claim_taken_over_from_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "claim_released_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "claim_released_by_user_id"`,
    );
  }
}
