import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing governance-concern outcomes:
 * `concern_update`, sent to the submitter of a "Submit a concern" form when an
 * admin resolves or dismisses it on the /admin/concerns dashboard (a logged-out
 * submitter is emailed instead — no account to notify).
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE` migrations
 * (e.g. AddHousingListingMatchNotificationType): `ALTER TYPE ... ADD VALUE` must
 * be COMMITTED before any statement may use the new label, so this opts out of
 * the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). `IF NOT EXISTS`
 * keeps it re-run-safe. `down()` is a no-op — Postgres has no
 * `ALTER TYPE ... DROP VALUE`, and the added label is harmless if left.
 */
export class AddConcernUpdateNotificationType1788600000000 implements MigrationInterface {
  name = 'AddConcernUpdateNotificationType1788600000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'concern_update'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added value is harmless.
  }
}
