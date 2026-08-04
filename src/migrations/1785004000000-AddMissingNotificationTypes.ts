// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the ~13 net-new values to `notifications_type_enum` that back the
 * platform-wide notification coverage sweep (P3/§K): RSVP-to-host, community
 * post reply, forum thread reply, community join-request received/approved/
 * declined, job application, listing approved, report resolved, appeal
 * resolved, invite accepted, business review, and roadmap idea status change.
 *
 * Mirrors `AddEventBusinessCompanyJobSubprofileReportSubjects1785002700000`
 * and `AddForumReplyNotificationType1785002100000` exactly: each value is only
 * ADDED and never USED in this same transaction, so `ALTER TYPE ... ADD VALUE`
 * is safe inside the migration transaction on PostgreSQL 12+. `IF NOT EXISTS`
 * keeps it re-run-safe alongside the enum's existing values. `down()` is a
 * documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`.
 */
export class AddMissingNotificationTypes1785004000000 implements MigrationInterface {
  name = 'AddMissingNotificationTypes1785004000000';

  private static readonly VALUES = [
    'event_rsvp',
    'community_reply',
    'forum_thread_reply',
    'join_request_received',
    'join_request_approved',
    'join_request_declined',
    'job_application',
    'listing_approved',
    'report_resolved',
    'appeal_resolved',
    'invite_accepted',
    'listing_review',
    'roadmap_status',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of AddMissingNotificationTypes1785004000000.VALUES) {
      await queryRunner.query(
        `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added values are harmless
    // if left in place.
  }
}
