import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_review_helpful_votes` — real "was this helpful" votes on directory
 * reviews.
 *
 * `listing_reviews.helpful` has existed since `1782800860000-AddListingReviews`
 * and was written as a literal `0` by the only code that ever set it, with no
 * endpoint able to move it. The number on the page counted nothing, which is
 * why the frontend removed the display and re-sorted by newest. These rows are
 * what it now counts, and the column stays as the denormalized tally so the
 * public review reads do not have to join or aggregate.
 *
 * ONE VOTE PER MEMBER PER REVIEW IS ENFORCED HERE, IN THE DATABASE, by
 * `UQ_listing_review_helpful_votes_voter` — the same posture
 * `UQ_listing_reviews_reviewer` already takes for the one-review-per-member
 * rule on the parent table, and for the same reason: an application-side check
 * is a read followed by a write, and two taps that interleave between them both
 * pass it. The write path inserts with `ON CONFLICT DO NOTHING`, so a repeat
 * vote converges on the existing row and returns the current count rather than
 * raising a 409 at somebody who pressed a button twice.
 *
 * The unique constraint doubles as the lookup index. It leads with `review_id`,
 * which is exactly the predicate of the per-review recount
 * (`COUNT(*) WHERE review_id = $1`) that keeps `listing_reviews.helpful` in
 * step, so no second index is warranted. The same reasoning `resource_guide_
 * rating`'s migration records for its own composite unique index.
 *
 * The rule this table CANNOT hold is "you may not vote on your own review": it
 * is a predicate across two tables (`voter_id` here against `reviewer_id`
 * there), which a Postgres CHECK cannot express. That one is enforced in
 * `DirectoryService.voteHelpful`, and this comment exists so nobody later
 * assumes the database is covering it.
 *
 * BOTH foreign keys are `ON DELETE CASCADE`. A deleted review takes its votes
 * with it — they have no meaning without it — and an erased account's votes
 * disappear rather than surviving as anonymous rows. That is a deliberate
 * departure from `listing_reviews.reviewer_id`'s erasure-safe `ON DELETE SET
 * NULL`: a review is content with standalone meaning that must outlive its
 * author, a tally entry is not. Same reasoning as
 * `1793000000000-CreateResourceGuideRating`'s `FK_resource_guide_rating_
 * member_id`.
 *
 * Fully transactional: one CREATE TABLE plus two ADD CONSTRAINTs on a table
 * created in the same transaction, so nothing here takes a lock on a table
 * anyone else is reading. No `CONCURRENTLY`, and no two-phase split.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class CreateListingReviewHelpfulVotes1794270000000 implements MigrationInterface {
  name = 'CreateListingReviewHelpfulVotes1794270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "listing_review_helpful_votes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "review_id" uuid NOT NULL,
        "voter_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_review_helpful_votes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_listing_review_helpful_votes_voter"
          UNIQUE ("review_id", "voter_id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_review_helpful_votes"
        ADD CONSTRAINT "FK_listing_review_helpful_votes_review_id"
        FOREIGN KEY ("review_id") REFERENCES "listing_reviews"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "listing_review_helpful_votes"
        ADD CONSTRAINT "FK_listing_review_helpful_votes_voter_id"
        FOREIGN KEY ("voter_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    // No backfill. Every existing `listing_reviews.helpful` is the literal 0
    // the old write path stored, so zero vote rows is already the truthful
    // state: there is nothing to reconstruct, because nothing was ever counted.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_review_helpful_votes" DROP CONSTRAINT "FK_listing_review_helpful_votes_voter_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_review_helpful_votes" DROP CONSTRAINT "FK_listing_review_helpful_votes_review_id"`,
    );
    await queryRunner.query(`DROP TABLE "listing_review_helpful_votes"`);
    // `listing_reviews.helpful` is left holding whatever the votes tallied to.
    // Resetting it to 0 would be the mirror image of this migration's own
    // "no backfill" note and would destroy real counts on a revert that is
    // meant to be reversible.
  }
}
