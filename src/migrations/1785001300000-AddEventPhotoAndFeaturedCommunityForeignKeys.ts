import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfills the missing foreign keys on two newish tables whose parent-id
 * columns were created as plain uuids with no referential integrity:
 *
 *   - `event_photos.event_id`     -> `events(id)`      ON DELETE CASCADE
 *   - `event_photos.uploader_id`  -> `users(id)`       ON DELETE SET NULL
 *   - `profile_featured_communities.user_id`      -> `users(id)`       ON DELETE CASCADE
 *   - `profile_featured_communities.community_id` -> `communities(id)` ON DELETE CASCADE
 *
 * `uploader_id` was created NOT NULL (see
 * `1785000600000-CreateEventPhotos`); `ON DELETE SET NULL` cannot fire on a
 * NOT NULL column, so it is first relaxed to nullable here (down() restores
 * NOT NULL).
 *
 * Also adds the two indexes that back the new SET NULL / lookup columns:
 * `event_photos.uploader_id` and `profile_featured_communities.community_id`
 * (the CASCADE columns `event_id` and `user_id` are already indexed by their
 * create migrations).
 *
 * NOTE: this migration assumes no orphan rows currently exist in either table
 * (a `*_id` pointing at a since-deleted parent). Foreign-key creation is
 * validated against existing data, so it will fail loudly if an orphan is
 * present — acceptable for these recently introduced tables, which have had FK
 * integrity in application code since day one.
 */
export class AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000 implements MigrationInterface {
  name = 'AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- event_photos -------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "event_photos" ALTER COLUMN "uploader_id" DROP NOT NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_event_photos_uploader_id" ON "event_photos" ("uploader_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "event_photos" ADD CONSTRAINT "FK_event_photos_event_id"
        FOREIGN KEY ("event_id") REFERENCES "events"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "event_photos" ADD CONSTRAINT "FK_event_photos_uploader_id"
        FOREIGN KEY ("uploader_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    // --- profile_featured_communities --------------------------------------
    await queryRunner.query(
      `CREATE INDEX "IDX_profile_featured_communities_community_id" ON "profile_featured_communities" ("community_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "profile_featured_communities" ADD CONSTRAINT "FK_profile_featured_communities_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "profile_featured_communities" ADD CONSTRAINT "FK_profile_featured_communities_community_id"
        FOREIGN KEY ("community_id") REFERENCES "communities"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- profile_featured_communities --------------------------------------
    await queryRunner.query(
      `ALTER TABLE "profile_featured_communities" DROP CONSTRAINT "FK_profile_featured_communities_community_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "profile_featured_communities" DROP CONSTRAINT "FK_profile_featured_communities_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_profile_featured_communities_community_id"`,
    );

    // --- event_photos -------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "event_photos" DROP CONSTRAINT "FK_event_photos_uploader_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_photos" DROP CONSTRAINT "FK_event_photos_event_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_event_photos_uploader_id"`);

    await queryRunner.query(
      `ALTER TABLE "event_photos" ALTER COLUMN "uploader_id" SET NOT NULL`,
    );
  }
}
