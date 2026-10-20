// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio safety and moderation: `studio_track` joins
 * `reports_subject_type_enum`, and the six in-app claim and track notices
 * join `notifications_type_enum`. Audit actions need no label:
 * `mod_audit_logs.action` is a plain varchar.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration
 * here: a new label must be COMMITTED before any statement may use it, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`). No
 * statement here uses a new label. `IF NOT EXISTS` keeps a re-run safe.
 */
export class AddStudioSafetyEnumValues1834000000000 implements MigrationInterface {
  name = 'AddStudioSafetyEnumValues1834000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE IF NOT EXISTS 'studio_track'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_copyright_claim_accepted'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_copyright_claim_declined'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_copyright_claim_countered'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_copyright_claim_decided'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_copyright_claim_withdrawn'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_track_marked'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value. Fails loudly so the
    // ledger row stays.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
