// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing persona-credit
 * notifications: `subprofile_credit`, sent to a member the first time a
 * persona's `replaceSection` save newly credits their @handle as a
 * collaborator (Personas discovery Phase 5, Moment 6).
 *
 * Mirrors `AddModerationOutcomeNotificationType1785900000000` exactly: the
 * value is only ADDED and never USED in this same transaction, so
 * `ALTER TYPE ... ADD VALUE` is safe inside the migration transaction on
 * PostgreSQL 12+. `IF NOT EXISTS` keeps it re-run-safe. `down()` is a
 * documented no-op — Postgres has no `ALTER TYPE ... DROP VALUE`.
 */
export class AddSubprofileCreditNotificationType1786700100000 implements MigrationInterface {
  name = 'AddSubprofileCreditNotificationType1786700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'subprofile_credit'`,
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
