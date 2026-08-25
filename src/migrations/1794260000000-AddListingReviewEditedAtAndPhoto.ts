import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listing_reviews.edited_at` + `listing_reviews.photo`: a review a member can
 * change, and a photo they can attach to it.
 *
 * EDITED_AT. A member gets exactly one review per listing (the partial unique
 * index `UQ_listing_reviews_reviewer`, since
 * `1785600200000-AddListingReviewReviewerDedupeIndex`). Until now there was no
 * way to change it, so the one-review rule meant a review written on a bad
 * night stood forever, and a business that fixed the thing the review was
 * about had no path to a corrected one. This column is what makes an edit
 * honest rather than silent: it records that the words changed, and the public
 * DTO exposes it beside `created_at`.
 *
 * The ordering case it exists for: `owner_reply_text`/`owner_replied_at`
 * already let the business answer a review in public. If a reviewer could then
 * rewrite the review with no trace, an owner's measured reply could be made to
 * sit under words the owner never saw. Comparing `edited_at` against
 * `owner_replied_at` is what lets the page say so
 * (`ReviewDTO.isEditedAfterOwnerReply`). The reply itself is NEVER cleared by
 * an edit, which would hand the reviewer a way to delete the owner's response
 * by changing one character of their own.
 *
 * NULL means never edited, which is the correct reading of every existing row.
 *
 * PHOTO. One optional image on a review, holding a storage key from the shared
 * presigned upload flow under the EXISTING `listing-photo` upload kind. Empty
 * string means "no photo", matching `listings.photos`'s four slots and the
 * empty-string convention `@IsImageReference` already accepts;
 * `toImageUrl('')` normalises it to `null` at the response boundary. Deliberately
 * NOT nullable, so there is one representation of "unset" rather than two.
 *
 * No index on either column: nothing filters or sorts on them. The review reads
 * are all keyed by `listing_id` (already indexed) and ordered by `created_at`.
 *
 * Fully transactional. Two `ALTER TABLE ... ADD COLUMN`s, one nullable and one
 * with a constant default, which on PostgreSQL 11+ are catalog-only changes
 * with no table rewrite. Same shape as `1794220000000-AddListingServices`.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingReviewEditedAtAndPhoto1794260000000 implements MigrationInterface {
  name = 'AddListingReviewEditedAtAndPhoto1794260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_reviews"
         ADD "photo" character varying NOT NULL DEFAULT '',
         ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_reviews"
         DROP COLUMN "edited_at",
         DROP COLUMN "photo"`,
    );
  }
}
