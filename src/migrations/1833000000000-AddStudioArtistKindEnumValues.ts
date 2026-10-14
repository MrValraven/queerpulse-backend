// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio artist kinds (`QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md`):
 * `podcast`, `edit` and `lip_sync` join `studio_releases_type_enum` (appended,
 * matching `StudioReleaseType`), and `studio_episode_published` joins
 * `notifications_type_enum` (a show you follow published an episode).
 *
 * TWO-PHASE / NON-TRANSACTIONAL, like every other `ADD VALUE` migration
 * here: a new label must be COMMITTED before any statement may use it, so
 * this opts out of the wrapping transaction (`transaction = false`, honoured
 * because `data-source.ts` sets `migrationsTransactionMode: 'each'`). Nothing
 * in this file uses the labels, and `IF NOT EXISTS` keeps a re-run safe.
 */
export class AddStudioArtistKindEnumValues1833000000000 implements MigrationInterface {
  name = 'AddStudioArtistKindEnumValues1833000000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "studio_releases_type_enum" ADD VALUE IF NOT EXISTS 'podcast'`,
    );
    await queryRunner.query(
      `ALTER TYPE "studio_releases_type_enum" ADD VALUE IF NOT EXISTS 'edit'`,
    );
    await queryRunner.query(
      `ALTER TYPE "studio_releases_type_enum" ADD VALUE IF NOT EXISTS 'lip_sync'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'studio_episode_published'`,
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
