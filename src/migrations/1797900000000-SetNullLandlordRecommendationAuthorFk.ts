// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The twelfth content-author FK, missed by
 * `SetNullContentAuthorFksOnUserErasure1794610000000`.
 *
 * That migration moved eleven content FKs off `ON DELETE CASCADE` because
 * erasing one member's account was deleting content OTHER people depend on:
 * gatherings with RSVPs, listings, and the reviews the next tenant or applicant
 * reads. `landlord_recommendations.author_user_id` was left behind at
 * `ON DELETE CASCADE`, and it is the same kind of content and then some.
 *
 * These recommendations are how tenants warn each other about landlords on a
 * queer housing platform. Under `CASCADE`, a member exercising erasure deleted
 * every warning they ever wrote, and because
 * `LandlordsService.rating()`/`ratingsFor()` aggregate over the surviving rows,
 * the landlord's public star rating moved at the same moment, with nothing
 * recording that it had. A landlord who wanted a bad rating gone had a route to
 * it that did not involve a moderator at all.
 *
 * After this, a warning survives its author leaving. It keeps its stars and its
 * text and loses its byline, which is precisely what the eleven FKs above
 * already do for `company_reviews.author_id` and `housing_reviews.author_id`.
 *
 * The column becomes nullable first: a `SET NULL` rule on a `NOT NULL` column
 * is a constraint Postgres accepts at DDL time and only fails on at delete
 * time, which would turn every erasure into a 500 rather than an anonymisation.
 *
 * `UQ_landlord_recommendations_author` is deliberately left alone. It is a
 * plain unique index on `(landlord_id, author_user_id)`, and Postgres treats
 * NULLs as distinct under one, so several anonymised recommendations coexist on
 * one landlord while a PRESENT member still cannot rate the same landlord
 * twice. That is the wanted behaviour: each anonymised row was a different
 * tenant, and collapsing them into one would erase warnings a second time.
 * (`listing_reviews` needed an explicit `WHERE reviewer_id IS NOT NULL` partial
 * index for the same effect only because its rule was written before the null
 * case existed; it is not required here.)
 *
 * Purely transactional: no `CREATE INDEX CONCURRENTLY`.
 * `IDX_landlord_recommendations_author_user_id` already covers the column and
 * `ALTER COLUMN ... DROP NOT NULL` leaves it in place.
 *
 * Paired application code: `LandlordRecommendation.authorUserId` is now
 * `string | null`, and every read in `LandlordsService` goes through
 * `presentActorIds`/`actorFromLookup` so a NULL never reaches a profile lookup.
 * `ContentOwnerErasureService` needs nothing: a recommendation is a review, and
 * that service's own docblock already records that reviews "keep their text and
 * lose their byline" with no action required.
 */
export class SetNullLandlordRecommendationAuthorFk1797900000000 implements MigrationInterface {
  name = 'SetNullLandlordRecommendationAuthorFk1797900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" DROP CONSTRAINT "FK_landlord_recommendations_author_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" ALTER COLUMN "author_user_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "landlord_recommendations" ADD CONSTRAINT "FK_landlord_recommendations_author_user_id"
        FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same caveat as `SetNullContentAuthorFksOnUserErasure1794610000000`'s
    // down(): restoring NOT NULL only succeeds while no row has actually been
    // NULLed by an erasure. Once an author has been erased, `SET NOT NULL`
    // correctly fails rather than silently resurrecting an id that no longer
    // exists, or quietly deleting a tenant's warning to make room.
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" DROP CONSTRAINT "FK_landlord_recommendations_author_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landlord_recommendations" ALTER COLUMN "author_user_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "landlord_recommendations" ADD CONSTRAINT "FK_landlord_recommendations_author_user_id"
        FOREIGN KEY ("author_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
