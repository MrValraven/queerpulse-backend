// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio purchases: `studio_purchase_claimed` (a buyer filed a payment claim
 * on a persona you run), `studio_purchase_confirmed`,
 * `studio_purchase_declined` and `studio_purchase_expired` (the answers the
 * buyer receives) join `notifications_type_enum`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses any label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddStudioPurchaseNotificationTypes1838000100000 implements MigrationInterface {
  name = 'AddStudioPurchaseNotificationTypes1838000100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_claimed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_confirmed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_declined'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_purchase_expired'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value, and the added labels are inert
    // once nothing writes them. Fails loudly so the ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
