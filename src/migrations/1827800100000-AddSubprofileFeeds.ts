// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persona feed import: `subprofile_feeds` (a podcast RSS feed connected to a
 * persona) and `subprofile_feed_entries` (one row per episode the feed has
 * ever offered).
 *
 * WHY A STAGING TABLE. `PUT /subprofiles/:id/sections/:section` replaces a
 * whole section and pairs rows BY POSITION, so a draft row kept inside
 * `subprofile_items` would be overwritten or deleted by the owner's next
 * section save, and every public read path would need a draft filter. Pending
 * episodes therefore live here; publishing one INSERTS an ordinary
 * `subprofile_items` row and records its id in `item_id`.
 *
 * FK behaviour.
 *  - `subprofile_feeds.subprofile_id` and both `subprofile_id` /`feed_id` on
 *    the entries CASCADE: a feed and its episode ledger mean nothing without
 *    the persona (a persona delete is a hard `DELETE`). Deleting a feed drops
 *    its entries; the items already published from it stay, because the FK
 *    runs from the entry to the item and not the other way.
 *  - `subprofile_feeds.created_by_id` is nullable and `ON DELETE SET NULL`, the
 *    actor-FK convention, so account erasure is never blocked by a feed. A
 *    feed whose creator is gone keeps syncing but never auto-publishes.
 *  - `subprofile_feed_entries.item_id` is `ON DELETE SET NULL`: an owner who
 *    deletes an imported item keeps the entry as `published`, so the episode
 *    is never re-offered as new.
 *
 * `section` reuses `subprofile_items_section_enum`, so the section an episode
 * publishes into is always one a section save could write.
 *
 * Indexes. `UQ_subprofile_feeds_subprofile_feed_url` leads with
 * `subprofile_id`, so it also serves the cascade and the per-persona list.
 * `IDX_subprofile_feeds_next_check_at` is the scheduler's due-feeds scan.
 * `UQ_subprofile_feed_entries_feed_guid` is the idempotency key every sync
 * inserts against and serves the `feed_id` cascade. The (feed, status,
 * published_at DESC) index is the review list's read. `subprofile_id`,
 * `item_id` and `created_by_id` carry their own indexes so the cascade / SET
 * NULL lookups a persona delete, an item delete or an account erasure run are
 * never a sequential scan (ENG-32, the
 * `1796310000000-AddTrustSafetyErasureForeignKeyIndexes` convention); the
 * latter two are partial, since a null is never looked up.
 *
 * TRANSACTIONAL, and safely so: both tables are created empty, so every index
 * builds in the same transaction with no `CONCURRENTLY`.
 */
export class AddSubprofileFeeds1827800100000 implements MigrationInterface {
  name = 'AddSubprofileFeeds1827800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_feeds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "created_by_id" uuid,
        "feed_url" character varying(2048) NOT NULL,
        "section" "subprofile_items_section_enum" NOT NULL,
        "title" character varying(300),
        "author" character varying(200),
        "image_key" character varying(255),
        "auto_publish" boolean NOT NULL DEFAULT false,
        "etag" character varying(512),
        "last_modified" character varying(100),
        "last_synced_at" TIMESTAMP WITH TIME ZONE,
        "last_attempt_at" TIMESTAMP WITH TIME ZONE,
        "next_check_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "consecutive_failures" integer NOT NULL DEFAULT 0,
        "last_error" character varying(20),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_feeds" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_feeds_subprofile_feed_url"
          UNIQUE ("subprofile_id", "feed_url"),
        CONSTRAINT "FK_subprofile_feeds_subprofile"
          FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_feeds_created_by"
          FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subprofile_feeds_next_check_at"
        ON "subprofile_feeds" ("next_check_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subprofile_feeds_created_by_id"
        ON "subprofile_feeds" ("created_by_id")
        WHERE "created_by_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "subprofile_feed_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "feed_id" uuid NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "guid" character varying(500) NOT NULL,
        "title" character varying(500) NOT NULL,
        "description" text,
        "link" character varying(2048),
        "published_at" TIMESTAMP WITH TIME ZONE,
        "duration_seconds" integer,
        "season" integer,
        "episode" integer,
        "remote_image_url" character varying(2048),
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "item_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_feed_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_feed_entries_feed_guid"
          UNIQUE ("feed_id", "guid"),
        CONSTRAINT "CHK_subprofile_feed_entries_status"
          CHECK ("status" IN ('pending', 'published', 'dismissed')),
        CONSTRAINT "FK_subprofile_feed_entries_feed"
          FOREIGN KEY ("feed_id")
          REFERENCES "subprofile_feeds"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_feed_entries_subprofile"
          FOREIGN KEY ("subprofile_id")
          REFERENCES "subprofiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_subprofile_feed_entries_item"
          FOREIGN KEY ("item_id")
          REFERENCES "subprofile_items"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subprofile_feed_entries_feed_status_published"
        ON "subprofile_feed_entries" ("feed_id", "status", "published_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subprofile_feed_entries_subprofile_id"
        ON "subprofile_feed_entries" ("subprofile_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_subprofile_feed_entries_item_id"
        ON "subprofile_feed_entries" ("item_id")
        WHERE "item_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "subprofile_feed_entries"`);
    await queryRunner.query(`DROP TABLE "subprofile_feeds"`);
  }
}
