import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `moderation_queue_alert`, the `notifications_type_enum` value behind the
 * moderator workload alert (TS-04).
 *
 * Written by `ModerationQueueAlertService`, an hourly cron, to every active
 * platform `moderator`/`admin` when a moderation queue crosses its warning or
 * critical threshold, and once more when it comes back to `ok`. Before this,
 * nothing anywhere alerted on queue depth: `join-request-sla.ts` computed a
 * due date and `medianResponseHours` sat on the admin dashboard, and both were
 * only ever seen by someone who had already opened the console.
 *
 * STAFF ONLY, and unmutable. The recipient list is a role query, so a member
 * can never receive one; the type carries no `NotificationPreferenceCategory`
 * (it is listed in `ALWAYS_DELIVERED_NOTIFICATION_TYPES` instead), so there is
 * no member-facing switch that could silence duty mail. It carries no actor id
 * either, matching `ReportFiled` and `GovernanceMotionReadyForReview`: an
 * operational alert must not be droppable because of a block or mute between
 * two staff members, and there is no person to name in the first place.
 *
 * ONE VALUE, NOT THREE. Warning, critical and recovery are all this type; the
 * level lives in the payload's `severity`, exactly as `ReportFiled` keeps its
 * four urgency levels in the payload rather than minting an enum value per
 * level. A future queue is then a code-only change with no migration at all.
 *
 * IN-APP ONLY. QueerPulse sends no email and never will, and this type is
 * deliberately absent from `PushNotificationListener`'s push whitelist too, so
 * it reaches the bell and nowhere else. No copy for this type anywhere may say
 * anything is on its way.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here
 * (e.g. `AddCommunitySupportOfferedNotificationType1795660200000`): the label
 * must be COMMITTED before any statement may use it, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses the new label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddModerationQueueAlertNotificationType1795720200000 implements MigrationInterface {
  name = 'AddModerationQueueAlertNotificationType1795720200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'moderation_queue_alert'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added label
    // is inert once nothing writes it (the cron reverts with the code, not
    // with the schema). Fails loudly rather than reporting a successful revert
    // that undid nothing, which would drop the ledger row and make the next
    // `migration:run` error on a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
