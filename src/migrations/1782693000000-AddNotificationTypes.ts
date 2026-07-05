import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationTypes1782693000000 implements MigrationInterface {
  name = 'AddNotificationTypes1782693000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new values are not USED in this same transaction.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'event_cancelled'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'introduction_made'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres has no DROP VALUE — rebuild the enum without the two added
    // values. Fails if any row still uses them (acceptable manual revert path).
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" RENAME TO "notifications_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "notifications_type_enum" AS ENUM('connection_request', 'connection_accepted', 'vouch_received', 'promoted_to_member', 'new_message', 'event_invite', 'event_reminder', 'waitlist_promoted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "notifications_type_enum" USING "type"::text::"notifications_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "notifications_type_enum_old"`);
  }
}
