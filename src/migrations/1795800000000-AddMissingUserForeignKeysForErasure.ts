// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-30: closes three tables that account erasure could never reach, plus the
 * one profile edge that leaks with them.
 *
 * WHY. `AccountDeletionProcessorService.eraseAccount` erases a member by
 * hard-deleting their `users` row and letting the schema do the rest: "every
 * other member-owned table carries an `ON DELETE CASCADE` FK to `users("id")`
 * and goes with it". That premise is load-bearing, and three tables were never
 * wired into it. Grepping all 457 migrations for each table name returns
 * exactly the migration that created it and nothing else, so no later
 * `ADD CONSTRAINT` ever supplied the missing edge:
 *
 *  - `flatmate_likes.from_user_id`      (`AddFlatmateLikes1787800300000`)
 *  - `housing_saved_searches.member_id` (`AddHousingSavedSearches1788300100000`)
 *  - `media_crops.owner_id`             (`AddMediaCrops1789400000000`)
 *
 * No service deletes any of them either, so erasing an account left behind a
 * permanent record of which flatmate profiles the member liked and which they
 * passed on, their named housing searches with the full criteria blob, and a
 * crop row per uploaded image, each keyed to a user id that no longer resolves
 * to anybody. That is member-private material surviving the erasure that was
 * supposed to remove it.
 *
 * THE FOURTH EDGE: `flatmate_likes.to_profile_id`. The like's target is not a
 * user column, it is `flatmate_profiles.id`, and it has no FK either. That
 * matters for the same reason: `flatmate_profiles.owner_id` IS
 * `ON DELETE CASCADE` to `users("id")` (`AddFlatmateProfiles1785000050000`), so
 * erasing a member deletes their flatmate profile and leaves every like and
 * pass pointing AT them behind, still naming a real, living decider in
 * `from_user_id`. Erasing the liked member therefore preserved a list of who
 * wanted to live with them. The same hole is reachable without erasure at all:
 * `DELETE /flatmates/mine` removes the profile row
 * (`FlatmateProfilesService`, `this.flatmates.remove(profile)`) and the
 * decisions about it simply accumulate forever.
 *
 * ON DELETE CASCADE ON ALL FOUR, and the choice is forced as much as it is
 * argued. Every one of these columns is `NOT NULL`, so `SET NULL` is not
 * available without first dropping the constraint, and a like from nobody, a
 * saved search belonging to nobody, or a crop owned by nobody is not a row
 * worth keeping in a nullable form. On the merits each is a member-private
 * artefact with no second party depending on it, which is precisely the
 * distinction `SetNullContentAuthorFksOnUserErasure1794610000000` drew: content
 * other members read (a gathering, a listing, a review) survives with a NULL
 * byline, while "every private or preference row" cascades. These are the
 * latter. Nothing breaks on the read side either: a like row only ever
 * surfaces as a mutual match, which cannot be mutual once one side is gone; a
 * saved search is only read back to its own owner and scanned by the go-live
 * alerts listener, which has nobody left to notify; and a crop is metadata for
 * a storage object that step 4 of the erasure deletes from the bucket by
 * `<kind>/<userId>/…` prefix anyway, so cascading removes a pointer to a file
 * that is already gone rather than costing anyone a framed image.
 *
 * ORPHANS FIRST, because `ADD CONSTRAINT` validates existing rows and would
 * otherwise abort the deploy. Every row deleted here is one whose user (or
 * whose flatmate profile) is already gone, which is exactly the residue this
 * migration exists to stop accumulating: unreachable by every read path in the
 * app, since each one starts from a live member or a live profile. Deleting
 * them is the backfill, not a side effect of it.
 *
 * NO NEW INDEXES. A cascade delete forces a lookup on the child column, so each
 * one needs an index, and each one already has a usable one: `member_id` has
 * `IDX_housing_saved_searches_member_id`, `owner_id` has
 * `idx_media_crops_owner_id`, `to_profile_id` has
 * `IDX_flatmate_likes_to_profile_id`, and `from_user_id` is the LEADING column
 * of `UQ_flatmate_likes_from_to`, which Postgres can use for the cascade probe.
 * Adding a fourth single-column index would duplicate that prefix and pay for
 * it on every write.
 *
 * Purely transactional: `DELETE` plus `ALTER TABLE ... ADD CONSTRAINT`, no
 * `CREATE INDEX CONCURRENTLY`, so this runs inside its own migration
 * transaction under `migrationsTransactionMode: 'each'` like any other.
 *
 * `down()` drops the four constraints. It cannot bring the orphan rows back;
 * they described people the database no longer holds, and restoring them would
 * be re-creating the leak.
 */
export class AddMissingUserForeignKeysForErasure1795800000000 implements MigrationInterface {
  name = 'AddMissingUserForeignKeysForErasure1795800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. flatmate_likes — the decider, and the profile decided on.
    await queryRunner.query(
      `DELETE FROM "flatmate_likes"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users" WHERE "users"."id" = "flatmate_likes"."from_user_id"
        )`,
    );
    await queryRunner.query(
      `DELETE FROM "flatmate_likes"
        WHERE NOT EXISTS (
          SELECT 1 FROM "flatmate_profiles"
           WHERE "flatmate_profiles"."id" = "flatmate_likes"."to_profile_id"
        )`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_likes"
        ADD CONSTRAINT "FK_flatmate_likes_from_user_id"
        FOREIGN KEY ("from_user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_likes"
        ADD CONSTRAINT "FK_flatmate_likes_to_profile_id"
        FOREIGN KEY ("to_profile_id") REFERENCES "flatmate_profiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // 2. housing_saved_searches — the member's own named searches.
    await queryRunner.query(
      `DELETE FROM "housing_saved_searches"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users"
           WHERE "users"."id" = "housing_saved_searches"."member_id"
        )`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_saved_searches"
        ADD CONSTRAINT "FK_housing_saved_searches_member_id"
        FOREIGN KEY ("member_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // 3. media_crops — reframe metadata for the uploader's own objects.
    await queryRunner.query(
      `DELETE FROM "media_crops"
        WHERE NOT EXISTS (
          SELECT 1 FROM "users" WHERE "users"."id" = "media_crops"."owner_id"
        )`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_crops"
        ADD CONSTRAINT "FK_media_crops_owner_id"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_crops" DROP CONSTRAINT "FK_media_crops_owner_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_saved_searches" DROP CONSTRAINT "FK_housing_saved_searches_member_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_likes" DROP CONSTRAINT "FK_flatmate_likes_to_profile_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_likes" DROP CONSTRAINT "FK_flatmate_likes_from_user_id"`,
    );
  }
}
