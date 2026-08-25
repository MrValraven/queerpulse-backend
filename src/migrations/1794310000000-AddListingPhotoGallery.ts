import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `listings.photo_gallery`: a listing's photos as an ORDERED list, replacing
 * the four fixed named slots.
 *
 * Photos were four columns' worth of fixed vocabulary: `photos` held
 * `{ wide, d1, d2, vibe }` and a parallel `alt` object held one string per
 * slot. That shape could not express a third detail shot, a fifth photo, a
 * cover the owner picked, or a caption, and it kept a photo and its own
 * description in two different columns that could drift apart (an alt string
 * could outlive the photo it described, and the directory detail page rendered
 * those orphans as caption cells).
 *
 * The new column holds `[{ image, alt, caption }]` in the order the owner
 * arranged. Index 0 is the cover. Each photo carries its own alt text, so the
 * description can never separate from the picture, and its own optional
 * caption. `alt` and `caption` are deliberately two fields: a caption is copy
 * shown to everybody, alt text describes the image for someone who cannot see
 * it, and collapsing them would either hide a caption from sighted readers or
 * feed "opening night!" to a screen reader as a description of the room.
 *
 * BACKFILL: every existing row is converted in slot order (`wide`, `d1`, `d2`,
 * `vibe`), empty slots skipped, each slot's alt text carried across, captions
 * empty. That preserves the order the wizard presented, so the photo that was
 * the "wide" shot becomes the cover, which is what it already was on every
 * card and detail page. Rows with no photos at all keep the `'[]'` default and
 * are simply not touched by the UPDATE.
 *
 * THE OLD COLUMNS ARE KEPT, NOT DROPPED, and this is the deliberate decision
 * of this migration:
 *
 * - Dropping `photos`/`alt` here would be irreversible in the way that matters.
 *   `down()` can recreate the columns, but a revert executed after the new code
 *   has been serving for a while would have to reconstruct member photos from
 *   the gallery, and any photo past the fourth would have nowhere to go. The
 *   whole point of this change is that a listing can now hold more than four.
 * - Keeping them makes a rollback real rather than theoretical. The columns are
 *   rewritten from the gallery on every save (`legacySlotsFromGallery`, called
 *   from `normalizeCreate` and `applyUpdate`), so a rollback to the previous
 *   release finds CURRENT data in the shape it expects, not a snapshot frozen
 *   at deploy time. A frozen mirror would have been the worst of both.
 * - The cost is honest and bounded: one derived write per save, and a shape
 *   that must never be read as a source of truth. Every read path resolves the
 *   legacy response fields FROM the gallery rather than from these columns, so
 *   the mirror cannot make a response wrong even if it drifts; the media
 *   reference resolver reads only `photo_gallery` for the same reason.
 *
 * Dropping them is a follow-up migration, to be written once the frontend has
 * stopped sending and reading `photos`/`alt` and one release has passed without
 * a rollback.
 *
 * FULLY TRANSACTIONAL. One `ADD COLUMN` with a constant default (catalog-only
 * on PostgreSQL 11+, no table rewrite) plus one `UPDATE`. Nothing here needs to
 * run outside a transaction, so this migration carries no special run
 * instructions.
 *
 * DO NOT RUN: authored for review only, the maintainer runs migrations.
 */
export class AddListingPhotoGallery1794310000000 implements MigrationInterface {
  name = 'AddListingPhotoGallery1794310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "photo_gallery" jsonb NOT NULL DEFAULT '[]'`,
    );

    // Slot order is the ordering rule: `wide` becomes the cover, then `d1`,
    // `d2`, `vibe`. The slot list is CROSS JOINed (not correlated into a
    // sub-select's FROM, which would need LATERAL), each slot's own alt string
    // travels with its image, and empty slots are filtered out BEFORE the
    // aggregate so they leave no holes in the array. A row whose photos are all
    // empty produces no group at all and keeps the `'[]'` default.
    await queryRunner.query(
      `UPDATE "listings" AS "target"
          SET "photo_gallery" = "built"."gallery"
         FROM (
           SELECT "slot"."id",
                  jsonb_agg(
                    jsonb_build_object(
                      'image', "slot"."image",
                      'alt', "slot"."alt",
                      'caption', ''
                    )
                    ORDER BY "slot"."position"
                  ) AS "gallery"
             FROM (
               SELECT "listing"."id",
                      "slot_name"."position",
                      COALESCE("listing"."photos" ->> "slot_name"."key", '') AS "image",
                      COALESCE("listing"."alt" ->> "slot_name"."key", '') AS "alt"
                 FROM "listings" AS "listing"
                 CROSS JOIN (
                   VALUES (1, 'wide'), (2, 'd1'), (3, 'd2'), (4, 'vibe')
                 ) AS "slot_name"("position", "key")
             ) AS "slot"
            WHERE "slot"."image" <> ''
            GROUP BY "slot"."id"
         ) AS "built"
        WHERE "target"."id" = "built"."id"`,
    );
  }

  /**
   * Maps the first four gallery entries back onto the named slots before
   * dropping the column, so a revert leaves the legacy pair describing the
   * listing as it stands rather than as it stood at deploy time.
   *
   * Every row is rewritten and every slot is always written, so a listing whose
   * photos were removed comes back with empty slots rather than with a stale
   * key the gallery no longer carries. Positions are read straight out of the
   * jsonb array (`-> n`, zero-based, NULL past the end), which is the same
   * first-four-entries mapping `legacySlotsFromGallery` performs in the service.
   *
   * Entries past the fourth, and every caption, have nowhere to go in the old
   * shape and are lost on revert. That is not a bug in this `down()`, it is the
   * limitation of the shape being reverted to, and it is why `up()` keeps the
   * old columns rather than trusting a reconstruction.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "listings" AS "target"
          SET "photos" = "built"."photos",
              "alt" = "built"."alt"
         FROM (
           SELECT "listing"."id",
                  jsonb_object_agg(
                    "slot_name"."key",
                    COALESCE(
                      "listing"."photo_gallery" -> ("slot_name"."position" - 1) ->> 'image',
                      ''
                    )
                  ) AS "photos",
                  jsonb_object_agg(
                    "slot_name"."key",
                    COALESCE(
                      "listing"."photo_gallery" -> ("slot_name"."position" - 1) ->> 'alt',
                      ''
                    )
                  ) AS "alt"
             FROM "listings" AS "listing"
             CROSS JOIN (
               VALUES (1, 'wide'), (2, 'd1'), (3, 'd2'), (4, 'vibe')
             ) AS "slot_name"("position", "key")
            GROUP BY "listing"."id"
         ) AS "built"
        WHERE "target"."id" = "built"."id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "photo_gallery"`,
    );
  }
}
