import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing moderation-outcome
 * notifications: `moderation_outcome`, sent to the member a `warn`/`suspend`/`ban`
 * lands on so they learn the decision and the reason (AUDIT-2026-07-30 §"Notification
 * coverage holes").
 *
 * Mirrors `AddSubprofileInviteNotificationTypes1785800500000` exactly: the value
 * is only ADDED and never USED in this same transaction, so
 * `ALTER TYPE ... ADD VALUE` is safe inside the migration transaction on
 * PostgreSQL 12+. `IF NOT EXISTS` keeps it re-run-safe. `down()` is a documented
 * no-op — Postgres has no `ALTER TYPE ... DROP VALUE`.
 */
export class AddModerationOutcomeNotificationType1785900000000 implements MigrationInterface {
  name = 'AddModerationOutcomeNotificationType1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'moderation_outcome'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added value is harmless if
    // left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
