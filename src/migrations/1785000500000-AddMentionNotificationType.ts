import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMentionNotificationType1785000500000 implements MigrationInterface {
  name = 'AddMentionNotificationType1785000500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Additive + idempotent. On PG 12+ ADD VALUE runs inside the migration
    // transaction because the new value is not USED in this same transaction.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'mention'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE — rebuilding the enum without this value is
    // a manual revert path (would fail if any row still uses it). No-op here.
  }
}
