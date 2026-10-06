// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-408: `forum_co_author_credit`, the notice a member gets when a forum
 * thread's author credits them as co-author.
 *
 * Non-transactional, like every `ADD VALUE` migration here
 * (`AddFundingNotificationTypes1828600200000`): a new label must be committed
 * before any statement may use it, and `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`, which honours `transaction = false`.
 * The app boots without it; the emit site logs and carries on until it runs.
 */
export class AddForumCoAuthorCreditNotificationType1830000000000 implements MigrationInterface {
  name = 'AddForumCoAuthorCreditNotificationType1830000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'forum_co_author_credit'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
