// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio discovery: `studio_credit_requested` (a persona you run was
 * credited on a track) and `studio_credit_accepted` (a persona accepted a
 * credit your release gave it) join `notifications_type_enum`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses either label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddStudioCreditNotificationTypes1831800100000 implements MigrationInterface {
  name = 'AddStudioCreditNotificationTypes1831800100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_credit_requested'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_credit_accepted'`,
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
