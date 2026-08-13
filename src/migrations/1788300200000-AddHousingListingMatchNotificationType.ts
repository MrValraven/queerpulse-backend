import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `notifications_type_enum` value backing housing saved-search alerts:
 * `housing_listing_match`, sent to a member when a NEW listing goes live that
 * matches one of their saved searches with alerts on (Wave B3 P2.5).
 *
 * TWO-PHASE / NON-TRANSACTIONAL, exactly like the other `ADD VALUE` migrations
 * (e.g. AddSafeSpaceVouchNotificationType): `ALTER TYPE ... ADD VALUE` must be
 * COMMITTED before any statement may use the new label, so this opts out of the
 * wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). `IF NOT EXISTS`
 * keeps it re-run-safe. `down()` is a no-op — Postgres has no
 * `ALTER TYPE ... DROP VALUE`, and the added label is harmless if left.
 */
export class AddHousingListingMatchNotificationType1788300200000 implements MigrationInterface {
  name = 'AddHousingListingMatchNotificationType1788300200000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'housing_listing_match'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; the added value is harmless.
  }
}
