// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `company_reviews.owner_reply_text` / `owner_replied_at` / `edited_at`: the
 * employer's right of reply to a review of them, and the honest record of a
 * review changed after that reply went up.
 *
 * WHY (PRD-47). QueerPulse carried five separate rating-and-review primitives
 * across its verticals and only ONE of them, the business directory, let the
 * subject answer. A cafe could reply to a bad review; an employer could not.
 * That is the same member action with two different moral settlements, and the
 * one an employer got was the worse one. These three columns are the employer
 * half of closing that: deliberately the SAME column pair
 * (`listing_reviews.owner_reply_text` / `owner_replied_at`, added in
 * `1785600000000`) plus the same `edited_at` (`1794260000000`), so the two
 * verticals hold one shape rather than two.
 *
 * ONE REPLY, NOT A THREAD. Columns on the review row rather than a replies
 * table, exactly as the directory does it. A review page is not a conversation
 * and the subject does not get the last word twice: replying again overwrites.
 *
 * THE ORDERING PROBLEM `edited_at` EXISTS FOR. A member gets one review per
 * company (`UQ_company_reviews (company_id, author_id)`), and that review is
 * now editable, which it needed to be: a complaint about a thing the employer
 * then fixed should not stand unchanged forever. But if the author could
 * rewrite it with no trace, they could post something mild, collect a warm
 * employer reply, then rewrite the review into an accusation, leaving the
 * employer apparently agreeing with words they never saw. Comparing
 * `edited_at` against `owner_replied_at` is what lets the page say the review
 * changed after the reply (`CompanyReviewDTO.isEditedAfterOwnerReply`).
 *
 * The reply is NEVER cleared by an edit. Clearing it would hand the reviewer a
 * delete button for the employer's public response, usable by changing one
 * character. Nothing is versioned either: republishing prior revisions would
 * mean publishing text a member has actively withdrawn.
 *
 * NULL on every column means "never happened", which is the correct reading of
 * every existing row.
 *
 * No index on any of the three: nothing filters or sorts on them. The review
 * reads are keyed by `company_id` (already indexed by
 * `IDX_company_reviews_company_id`) and ordered by `created_at`.
 *
 * Fully transactional. Three nullable `ALTER TABLE ... ADD COLUMN`s, which on
 * PostgreSQL 11+ are catalog-only changes with no table rewrite. Same shape as
 * `1794260000000-AddListingReviewEditedAtAndPhoto`.
 */
export class AddCompanyReviewEmployerReply1796900000000 implements MigrationInterface {
  name = 'AddCompanyReviewEmployerReply1796900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_reviews"
         ADD "owner_reply_text" text,
         ADD "owner_replied_at" TIMESTAMP WITH TIME ZONE,
         ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "company_reviews"
         DROP COLUMN "edited_at",
         DROP COLUMN "owner_replied_at",
         DROP COLUMN "owner_reply_text"`,
    );
  }
}
