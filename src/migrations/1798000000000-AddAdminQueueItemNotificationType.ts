// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `admin_queue_item`, the `notifications_type_enum` value behind admin queue
 * arrival alerts.
 *
 * Written by `AdminQueueNotificationsService.announce`, called from every
 * creation site that puts a row into an admin review queue, to the staff who
 * can work that queue. Before this, an arrival was silent: `report_filed`
 * covered reports alone, and `moderation_queue_alert` reports a BACKLOG once a
 * threshold is crossed rather than an arrival, so a single invite request
 * produced nothing at all until the queue was already in breach.
 *
 * STAFF ONLY, and unmutable. Recipients are resolved from a role and grant
 * query, so a member can never receive one; the type carries no
 * `NotificationPreferenceCategory` (it is listed in
 * `ALWAYS_DELIVERED_NOTIFICATION_TYPES` instead), so no member-facing switch
 * can silence duty mail. It carries no actor id either, matching `ReportFiled`
 * and `ModerationQueueAlert`: a staff alert must not be droppable because of a
 * block or mute between the submitting member and whoever is on shift, and the
 * bell must never name the submitter.
 *
 * ONE VALUE FOR TWENTY-SIX QUEUES. The queue lives in the payload's `queue`
 * field, exactly as `ModerationQueueAlert` keeps its three severity levels and
 * `ReportFiled` its four urgency levels in the payload. A future queue is then
 * a code-only change with no migration at all.
 *
 * IN-APP ONLY. QueerPulse sends no email and never will, and this type is
 * deliberately absent from `PushNotificationListener`'s push whitelist, so it
 * reaches the bell and nowhere else. An arrival in a review queue is not worth
 * waking somebody for, and the person it is for opens the console anyway.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * the label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses the new label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddAdminQueueItemNotificationType1798000000000 implements MigrationInterface {
  name = 'AddAdminQueueItemNotificationType1798000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'admin_queue_item'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it. Fails loudly rather than reporting a
    // successful revert that undid nothing, which would drop the ledger row
    // and make the next `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
