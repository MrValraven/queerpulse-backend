// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v3 artist tools: `scheduled` joins `studio_releases_status_enum`
 * (placed before `published`, matching `StudioReleaseStatus`), and
 * `persona_post` joins `notifications_type_enum` and
 * `reports_subject_type_enum`.
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration
 * here: a new label must be COMMITTED before any statement may use it, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `AddStudioArtistTools1832000100000` uses `scheduled` in a CHECK and a
 * partial index, so it runs after this one. `IF NOT EXISTS` keeps a re-run
 * safe.
 */
export class AddStudioArtistToolsEnumValues1832000000000 implements MigrationInterface {
  name = 'AddStudioArtistToolsEnumValues1832000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "studio_releases_status_enum" ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'published'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'persona_post'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE IF NOT EXISTS 'persona_post'`,
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
