import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `writer_application_approved` and `writer_application_declined` to
 * `notifications_type_enum`, sent to a magazine writer applicant when an
 * admin triages their application (SDD 2026-08-18 "magazine writer
 * applications"). Mirrors `AddEventCohostInviteNotificationType1790500000000`
 * exactly: ADD VALUE only, never used in the same transaction, so this is
 * safe inside the migration transaction on PostgreSQL 12+. `down()` is a
 * documented no-op; Postgres cannot drop an enum value.
 */
export class AddWriterApplicationNotificationTypes1790700000000 implements MigrationInterface {
  name = 'AddWriterApplicationNotificationTypes1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'writer_application_approved'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'writer_application_declined'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added values are
    // harmless if left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
