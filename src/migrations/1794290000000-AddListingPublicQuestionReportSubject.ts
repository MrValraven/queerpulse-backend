import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `listing_public_question` to `reports_subject_type_enum`, so a public
 * question on a business listing (and the answer under it) is reportable and,
 * therefore, takedown-able.
 *
 * This is the whole moderation story for the feature, and it is deliberately
 * not a new mechanism. A `hide_content`/`remove_content` action on a
 * `listing_public_question` subject writes a `content_moderation` row keyed by
 * the question's uuid, and the public reads in `DirectoryService` filter on it
 * through the same `dropModeratedQuestions`/`excludeModeratedQuestions` pair
 * that already drops taken-down reviews. Member-written public text on this
 * page goes through the pipeline the platform already runs, rather than a
 * parallel one that would have to be audited separately and would drift.
 *
 * ONE subject covers the question and its answer together. That follows the
 * `review` precedent, where an owner's reply is likewise not separately
 * takedown-able: a reply read without the review it answers is a different
 * statement, and so is an answer read without its question.
 *
 * Reason codes are code-side (`reports.reason_code` is a free `varchar`), so
 * `SUBJECT_REASONS` in `reason-catalogue.ts` is the only other change; that map
 * is a total `Record<ReportSubjectType, ...>`, so a new enum member cannot be
 * added without one.
 *
 * ADD VALUE only, never used in the same transaction, which is safe inside the
 * migration transaction on PostgreSQL 12+ — mirrors
 * `AddReviewReportSubject1785800400000` exactly.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingPublicQuestionReportSubject1794290000000 implements MigrationInterface {
  name = 'AddListingPublicQuestionReportSubject1794290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'listing_public_question'`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label that
    // is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
