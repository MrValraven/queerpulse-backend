import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `writer_application_approved` and `writer_application_declined` to
 * `notifications_type_enum`, sent to a magazine writer applicant when an
 * admin triages their application (SDD 2026-08-18 "magazine writer
 * applications"). Mirrors `AddEventCohostInviteNotificationType1790500000000`
 * exactly: ADD VALUE only, never used in the same transaction, so this is
 * safe inside the migration transaction on PostgreSQL 12+. `down()` is a
 * documented no-op; Postgres cannot drop an enum value.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddWriterApplicationNotificationTypes1790700000000
  implements MigrationInterface
{
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
    // No-op: Postgres cannot drop an enum value; the added values are
    // harmless if left in place.
  }
}
