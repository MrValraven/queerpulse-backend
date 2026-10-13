// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v1: `studio_release` joins `reports_subject_type_enum`, and
 * `studio_release` and `studio_track` join `saved_item_subject_type_enum`.
 * Runs after `AddStudio1830900000000`.
 *
 * Reason codes are code-side (`SUBJECT_REASONS` in `reason-catalogue.ts`, a
 * total `Record<ReportSubjectType, ...>`), and `FEATURE_BY_KIND` in
 * `saved-availability.service.ts` is total over `SavedKind`, so both maps
 * grow in the same change.
 *
 * ADD VALUE only, and no statement here uses a new label, which is safe
 * inside the migration transaction on PostgreSQL 12+. Mirrors
 * `AddPhotoAndRecommendationReportSubjects1797700000000`. Unguarded on
 * purpose: a second run against labels the ledger already records should
 * fail and surface the drift.
 */
export class AddStudioReportAndSavedKinds1830900100000 implements MigrationInterface {
  name = 'AddStudioReportAndSavedKinds1830900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'studio_release'`,
    );
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'studio_release'`,
    );
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'studio_track'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`; a silent no-op would drop
    // the ledger row and make the next run fail on labels still present.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
