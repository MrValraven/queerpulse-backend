// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio open demo pages: `studio_release_taken_down` (staff took a release
 * down) and `studio_release_dispute_decided` (staff decided the artist's
 * dispute) join `notifications_type_enum`. Both reach the persona's owners.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses either label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddStudioTakedownNotificationTypes1831700200000 implements MigrationInterface {
  name = 'AddStudioTakedownNotificationTypes1831700200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_release_taken_down'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_release_dispute_decided'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value, and the added labels
    // are inert once nothing writes them. Fails loudly so the ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
