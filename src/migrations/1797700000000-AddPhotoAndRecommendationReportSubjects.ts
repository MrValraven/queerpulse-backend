// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `event_photo` and `landlord_recommendation` to
 * `reports_subject_type_enum`, so one photograph in a gathering's album and one
 * tenant's recommendation of a landlord each become reportable and, therefore,
 * takedown-able on their own.
 *
 * WHY THE TAXONOMY IS WIDENED AT ALL, given it is deliberately narrow. Both
 * surfaces already had a report subject one grain too coarse, and in both cases
 * acting on it destroys other people's content:
 *
 *  - `event` reports a whole gathering. A photograph of an identifiable person
 *    at a queer event could previously be removed only by the member who
 *    uploaded it or by an organizer, which on the reports that matter most is
 *    the very people being complained about. The alternative was taking down
 *    the gathering.
 *  - `landlord` reports a whole directory entry, and its recommendations are how
 *    tenants warn each other about a landlord. Acting on a complaint about one
 *    of them took down every other tenant's warning with it.
 *
 * Neither is a new mechanism. A `hide_content`/`remove_content` on either
 * subject writes a `content_moderation` row keyed by the photo's or the
 * recommendation's uuid, and the read paths filter on it through the same pair
 * of helpers that already drop taken-down reviews and questions. This follows
 * `AddListingPublicQuestionReportSubject1794290000000` exactly.
 *
 * Reason codes are code-side (`reports.reason_code` is a free `varchar`), so
 * `SUBJECT_REASONS` in `reason-catalogue.ts` is the only other backend change;
 * that map is a total `Record<ReportSubjectType, ...>`, so neither value could
 * be added without one. The frontend mirror in
 * `queerpulse/src/features/safety/reportReasons.ts` is a total `Record` for the
 * same reason and is updated in the same change.
 *
 * ADD VALUE only, never used in the same transaction, which is safe inside the
 * migration transaction on PostgreSQL 12+ — mirrors
 * `AddListingPublicQuestionReportSubject1794290000000` and
 * `AddReviewReportSubject1785800400000`.
 */
export class AddPhotoAndRecommendationReportSubjects1797700000000 implements MigrationInterface {
  name = 'AddPhotoAndRecommendationReportSubjects1797700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'event_photo'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'landlord_recommendation'`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the labels
    // that are still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
