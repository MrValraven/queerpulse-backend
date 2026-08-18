import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `volunteer_application_received` (to the poster, on a new or
 * reapplied signup) and `volunteer_application_decided` (to the applicant, on
 * accept/decline) to `notifications_type_enum`. Mirrors
 * `AddEventCohostInviteNotificationType1790500000000` exactly: ADD VALUE
 * only, never used in the same transaction, so this is safe inside the
 * migration transaction on PostgreSQL 12+. `down()` is a documented no-op;
 * Postgres cannot drop an enum value.
 *
 * DO NOT RUN. Authored for review only; the maintainer runs migrations.
 */
export class AddVolunteerApplicationNotificationTypes1790700000000 implements MigrationInterface {
  name = 'AddVolunteerApplicationNotificationTypes1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'volunteer_application_received'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'volunteer_application_decided'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added values are
    // harmless if left in place.
  }
}
