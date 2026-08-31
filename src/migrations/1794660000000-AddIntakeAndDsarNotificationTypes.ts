import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two notification types that were being borrowed from, plus the marker that
 * stops the account-deletion final warning repeating.
 *
 * 1. `intake_reviewed`. `IntakesService.notifySubmitter` fired
 *    `concern_update` for EVERY intake kind, so a Culture playlist submission,
 *    a micro-grant application and a sober-host listing all reached the
 *    member's bell reading "The concern you raised has been reviewed" — wrong
 *    for eleven of the twelve kinds, and quietly alarming for a member who
 *    never raised a concern. Only `governance_concern` keeps `concern_update`.
 *
 * 2. `dsar_resolved`. `AdminDsarService.updateStatus` borrowed the same value,
 *    so a member who exercised a statutory data right was told about a
 *    "concern". Covers both terminal outcomes (`resolved` and `rejected`); the
 *    payload carries the member's own case `reference` so they can match the
 *    row to what they filed.
 *
 * 3. `deletion_request.final_warning_sent_at`. `account_deletion_final_warning`
 *    has existed (with its copy and its own migration) since ID-06 with no emit
 *    site. The emit lands in `AccountDeletionProcessorService`, a DAILY cron —
 *    so without a marker column every member in the grace window would be
 *    warned every single day. Nullable, stamped by a conditional UPDATE that
 *    only moves a row whose marker is still NULL, exactly the way the erasure
 *    sweep claims a row, so two replicas ticking together cannot double-send.
 *
 * TRANSACTIONAL, unlike the `transaction = false` enum migrations next door
 * (e.g. `AddApprovalQueueNotificationTypes1794740000000`): the rule those opt
 * out for is that a new enum label may not be USED in the transaction that
 * added it. Nothing here uses one — the column below is on `deletion_request`
 * and has no relationship to `notifications_type_enum` — so PostgreSQL 12+
 * runs both statements together safely, the same reasoning
 * `AddListingPublicQuestionNotificationTypes1794300000000` records.
 *
 * `IF NOT EXISTS` on the two `ADD VALUE` statements is the standing idiom for
 * enum labels here. The column is added unguarded, per CLAUDE.md: an "already
 * exists" failure there is real schema drift and should be diagnosed with
 * `migration:show`, not silenced.
 */
export class AddIntakeAndDsarNotificationTypes1794660000000 implements MigrationInterface {
  name = 'AddIntakeAndDsarNotificationTypes1794660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'intake_reviewed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'dsar_resolved'`,
    );
    await queryRunner.query(
      `ALTER TABLE "deletion_request" ADD COLUMN "final_warning_sent_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverts the half that CAN be reverted, and does not pretend about the
    // other half. Dropping the column is a real undo; Postgres cannot drop an
    // enum label, and the two added labels are inert once nothing writes them
    // (the emit sites revert with the code, not with the schema).
    //
    // This deliberately does NOT throw the way the pure `ADD VALUE` migrations
    // here do. Those throw because a silent no-op would delete their ledger row
    // while leaving the labels in place; this one has real work to undo, and
    // re-running `up()` afterwards succeeds because the column is genuinely
    // gone and both `ADD VALUE` statements carry `IF NOT EXISTS`.
    await queryRunner.query(
      `ALTER TABLE "deletion_request" DROP COLUMN "final_warning_sent_at"`,
    );
  }
}
