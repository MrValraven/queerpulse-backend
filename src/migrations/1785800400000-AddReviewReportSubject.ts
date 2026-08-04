// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'review' to the reports subject-type enum so a directory-listing review
 * (`listing_reviews`) becomes reportable and, therefore, takedown-able: a
 * moderator `hide_content`/`remove_content` on a `review` subject writes a
 * `content_moderation` row (keyed by the review's uuid) that
 * `DirectoryService`'s review reads filter out.
 *
 * Only ADDS the value (never uses it in the same transaction), so it is safe on
 * PostgreSQL 12+ where `ALTER TYPE ... ADD VALUE` may run inside the migration
 * transaction — mirrors `AddLandlordReportSubject1785000100000` /
 * `AddEventBusinessCompanyJobSubprofileReportSubjects1785002700000`. Plain
 * `ADD VALUE` (no `IF NOT EXISTS`) matches this repo's migration convention.
 * Reason codes / severity are code-side (`reason_code` is a free `varchar`), so
 * no other column changes. `down()` is a documented no-op — Postgres has no
 * `ALTER TYPE ... DROP VALUE`.
 */
export class AddReviewReportSubject1785800400000 implements MigrationInterface {
  name = 'AddReviewReportSubject1785800400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'review'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; 'review' is harmless if left.
  }
}
