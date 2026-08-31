import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the listing owner's single public reply to a review: `owner_reply_text`
 * + `owner_replied_at`, both nullable (null = no reply yet). Posting a reply
 * overwrites both columns rather than appending — one reply per review, not a
 * thread. Mirrors `AddListingCoordinates`'s bare `ADD`/`DROP COLUMN` shape.
 */
export class AddListingReviewOwnerReply1785002300000 implements MigrationInterface {
  name = 'AddListingReviewOwnerReply1785002300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" ADD "owner_reply_text" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" ADD "owner_replied_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" DROP COLUMN "owner_replied_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listing_reviews" DROP COLUMN "owner_reply_text"`,
    );
  }
}
