// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `report_received`, the `notifications_type_enum` value behind the REPORTER's
 * own receipt (PRD-289).
 *
 * WHY IT EXISTS. The two existing report values are duty mail for responders:
 * `report_filed` goes to platform `moderator`/`admin` accounts and
 * `community_report_filed` to a community's owner, co-owners and mods, and both
 * fan-outs explicitly EXCLUDE the member who filed. So the reporter's first
 * in-app word about their own report was `report_resolved`, which is written
 * when a moderator closes the case: up to seven days later on the low severity
 * band. A reporter who dismissed the submit confirmation had nothing to look at
 * in between, on the one flow the safety copy sends everyone to. This value is
 * the durable half of that confirmation.
 *
 * WHAT IS WRITTEN UNDER IT. Exactly one row per genuinely new filing, to
 * `reports.reporter_id`, at filing time. `ReportNotificationsListener
 * .notifyReporter` writes it, and writes nothing when that column is null: a
 * signed-out filing (`POST /reports` is public) has no account to reach, and
 * `notifications.user_id` carries a foreign key to `users(id)`.
 *
 * ANONYMITY DOES NOT SUPPRESS IT. `reports.anonymous` shields the reporter from
 * moderators and from the reported party; it has never governed what the
 * reporter may see about their own report, which is how `report_resolved`
 * already reads it.
 *
 * NO ACTOR, NO PREFERENCE CATEGORY, NO PUSH. It carries no user id in its
 * payload and passes no actor to `NotificationsService.create`, so no block or
 * mute can swallow it; it joins `ALWAYS_DELIVERED_NOTIFICATION_TYPES` as safety
 * mail; and it is absent from the push whitelist like every other report type,
 * because the member is holding the phone that just filed it. The payload is
 * the case reference the reporter already sees on `GET /reports/mine`, the
 * subject type they chose, and the derived severity band. Nothing about the
 * reported party rides along.
 *
 * IN-APP ONLY. QueerPulse sends no email and never will, so nothing about this
 * type may be described as one.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `notifications_type_enum`
 * `ADD VALUE` migration here: the label must be COMMITTED before any statement
 * may use it, so this opts out of the wrapping transaction (`transaction =
 * false`, honoured because `data-source.ts` sets `migrationsTransactionMode:
 * 'each'`). Nothing in this file uses the new label, and `IF NOT EXISTS` keeps
 * it re-run-safe.
 */
export class AddReportReceivedNotificationType1813010000000 implements MigrationInterface {
  name = 'AddReportReceivedNotificationType1813010000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'report_received'`,
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
