// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Funding & Grants (P3): `funding_deadline_soon` (the 7-day and 1-day
 * reminders) and `funding_deadline_changed` (a saved call's deadline moved).
 *
 * Non-transactional, like every `ADD VALUE` migration here
 * (`AddMagazinePitchPassedNotificationType1826000100000`): a new label must be
 * committed before any statement may use it, and `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`, which honours `transaction = false`.
 * The app boots without it; the two emit sites log and carry on until it runs.
 */
export class AddFundingNotificationTypes1828600200000 implements MigrationInterface {
  name = 'AddFundingNotificationTypes1828600200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'funding_deadline_soon'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'funding_deadline_changed'`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
