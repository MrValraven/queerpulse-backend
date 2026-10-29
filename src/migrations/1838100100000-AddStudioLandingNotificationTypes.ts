// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio landing page: `studio_access_granted` (our team granted the Studio
 * access a member asked for), `studio_landing_preview_requested` (a track
 * preview of a persona you run waits for an answer) and
 * `studio_landing_preview_live` (an owner approved a preview) join
 * `notifications_type_enum`, in that order.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration here:
 * a new label must be COMMITTED before any statement may use it, so this opts
 * out of the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing in this
 * file uses any label, and `IF NOT EXISTS` keeps it re-run-safe.
 */
export class AddStudioLandingNotificationTypes1838100100000 implements MigrationInterface {
  name = 'AddStudioLandingNotificationTypes1838100100000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_access_granted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_landing_preview_requested'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_landing_preview_live'`,
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
