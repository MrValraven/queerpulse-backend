// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-433. The four bell notifications a member receives about a business
 * listing they SUGGESTED (a listing the platform holds, `owner_id IS NULL`):
 * it went live, a moderator needs more information, it was sent back to
 * review, or it was removed. They replace the plain-English DM the acting
 * moderator's personal account used to send.
 *
 * `transaction = false` because Postgres refuses `ALTER TYPE ... ADD VALUE`
 * inside a transaction block on older servers, and a new value cannot be used
 * in the transaction that added it on any server.
 */
export class AddListingSuggestionNotificationTypes1824100000000 implements MigrationInterface {
  name = 'AddListingSuggestionNotificationTypes1824100000000';
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_suggestion_live'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_suggestion_needs_info'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_suggestion_sent_back'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'listing_suggestion_removed'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
