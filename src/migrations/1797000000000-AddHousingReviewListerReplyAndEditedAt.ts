// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `housing_reviews.lister_reply_text` / `lister_replied_at` / `edited_at`: the
 * lister's right of reply to a review of their home, and the stamp that keeps
 * that reply honest (PRD-47).
 *
 * THE GAP THESE CLOSE. Five rating and review primitives across the verticals
 * and only directory listings let the subject say anything back. A cafe could
 * answer a bad review; the person whose home was reviewed could not. The
 * product decision is one reply, from the subject only, labelled as the
 * subject, reportable. These columns are the housing half of it, and they are
 * deliberately the same shape as `listing_reviews.owner_reply_text` /
 * `owner_replied_at` / `edited_at` so the two verticals cannot drift.
 *
 * LISTER_REPLY_TEXT / LISTER_REPLIED_AT. One reply per review, stored ON the
 * review row rather than in a table of its own: the reply is a property of the
 * statement it answers, and read apart from that statement it is not the same
 * statement. That is also why it gets no report subject of its own — the
 * review's existing `review` subject covers the pair, exactly as
 * `ReportSubjectType.Review` already says it does for the business side. Posting
 * again overwrites both columns, so this is a reply and never a thread.
 *
 * Both NULL means "not answered", which is the correct reading of every
 * existing row. Nullable rather than an empty-string default because the
 * timestamp beside it has no honest empty value, and one representation of
 * "unset" beats two that can disagree.
 *
 * THE BLINDNESS RULE IS NOT IN THE SCHEMA, and that is deliberate. Housing
 * reviews are blind and mutual: neither party sees the other's words until both
 * have submitted or the anti-retaliation window elapses. A reply PROVES the
 * lister has read the review, so it is refused until the review has revealed —
 * which is the same predicate the public block filters on, so a reply becomes
 * possible at the instant the review acquires a public audience and never
 * before. That rule spans rows (it counts the viewing's pair) and depends on
 * wall-clock time, so no CHECK constraint can express it; it lives in
 * `HousingReviewsService.replyToReview`, which is where a reader looking for it
 * will be.
 *
 * EDITED_AT. Nullable, NULL meaning never edited. A member gets exactly one
 * review per listing (`UQ_housing_reviews_listing_author`), so an edit path is
 * what makes that rule fair to keep; this column is what makes the edit honest
 * rather than silent.
 *
 * The ordering case it exists for is the same one the business directory hit:
 * an edit NEVER clears the reply, because clearing it would hand the reviewer a
 * delete button for the lister's public response, usable by changing one
 * character. So the review can move under a reply that is already published.
 * Comparing `edited_at` against `lister_replied_at` is what lets the page say
 * so (`HousingReviewDTO.isEditedAfterListerReply`); without it a guest could
 * post something mild, collect a warm reply, then rewrite the review into an
 * accusation, leaving the lister apparently agreeing with words they never saw.
 *
 * NO INDEX on any of the three: nothing filters or sorts on them. Every read
 * here is keyed by `listing_id` or `viewing_id` (both already indexed) and
 * ordered by `submitted_at`.
 *
 * FULLY TRANSACTIONAL. Three nullable `ADD COLUMN`s, which on PostgreSQL 11+
 * are catalog-only changes with no table rewrite. Same shape as
 * `1794260000000-AddListingReviewEditedAtAndPhoto`.
 */
export class AddHousingReviewListerReplyAndEditedAt1797000000000 implements MigrationInterface {
  name = 'AddHousingReviewListerReplyAndEditedAt1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_reviews"
         ADD "lister_reply_text" character varying(2000),
         ADD "lister_replied_at" TIMESTAMP WITH TIME ZONE,
         ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_reviews"
         DROP COLUMN "edited_at",
         DROP COLUMN "lister_replied_at",
         DROP COLUMN "lister_reply_text"`,
    );
  }
}
