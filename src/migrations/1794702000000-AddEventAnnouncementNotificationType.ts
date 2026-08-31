import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value behind host announcements (LOC-06).
 *
 * `event_announcement` reaches everyone holding a stake in a gathering (a live
 * RSVP of any kind, or a standing invite) when its host or a co-host posts an
 * announcement: "we moved to the back room", "the door code is 4471". It
 * carries the sending organiser as `payload.actorId`, so block/mute filtering
 * applies like any member-driven type, and it carries the announcement body,
 * because every recipient is somebody the host addressed on purpose and can
 * already read the same text on the event page.
 *
 * No `NotificationPreferenceCategory` gates it: the member's own RSVP is the
 * consent, the same shape `HousingListingMatch`'s `alertsEnabled` and
 * `TopicNewPost`'s follow rely on.
 *
 * Delivered in-app plus push. QueerPulse sends no email and never will, so
 * nothing about this type may be described as one.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like every other `ADD VALUE`
 * migration here (e.g. `AddReportFiledNotificationTypes1794600000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddEventAnnouncementNotificationType1794702000000 implements MigrationInterface {
  name = 'AddEventAnnouncementNotificationType1794702000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_announcement'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added label is
    // harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, since a silent no-op removes the ledger row and the next
    // `migration:run` retries `ADD VALUE` against a label that is still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
