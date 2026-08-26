// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `notifications_type_enum` values behind "tell a moderator a
 * report has landed" (TS-04). Filing a report used to fire no notification at
 * all, so the 1-hour outing/doxxing SLA depended on someone happening to be
 * inside the admin console looking at a count pill.
 *
 * - `report_filed`: to platform staff (`users.role` of `moderator`/`admin`)
 *   whenever a new report is filed, deep-linking to the moderation queue.
 * - `community_report_filed`: to the owner, co-owners and mods of the
 *   community a reported post or reply belongs to (or of a reported community
 *   itself), deep-linking to that community's mod tools.
 *
 * Both are written by `ReportNotificationsListener`, a second listener on the
 * existing `REPORT_CREATED` event, so a notification failure can never fail
 * the member's report submission.
 *
 * Emergency severity gets no enum value of its own: the payload's `severity`
 * field carries all four levels, the bell keys its urgent copy and icon off
 * it, and only `emergency` reaches the push transport.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE`
 * migrations (e.g. `AddCommunityNotificationTypes1793940000000`):
 * `ALTER TYPE ... ADD VALUE` must be COMMITTED before any statement may use
 * the new label, so this opts out of the wrapping transaction
 * (`transaction = false`, honoured because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddReportFiledNotificationTypes1794600000000 implements MigrationInterface {
  name = 'AddReportFiledNotificationTypes1794600000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'report_filed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'community_report_filed'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added labels are
    // harmless. Fails loudly rather than reporting a successful revert that
    // undid nothing, since a silent no-op removes the ledger row and the next
    // `migration:run` retries `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
