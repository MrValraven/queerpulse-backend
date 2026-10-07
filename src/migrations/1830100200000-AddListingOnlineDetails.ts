// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  convertOnlineListingRowDown,
  convertOnlineListingRowUp,
} from '../database/listing-online-details-migration';

/**
 * Online listings get their own field set
 * (`QUEERPULSE-ONLINE-LISTINGS-DESIGN-2026-10-07.md`).
 *
 * Schema: `has_online_shop` (a place that also sells online),
 * `online_details` (the structured "Ordering & delivery" facts) and
 * `shop_items` ("In the shop"). `pricing_mode` is a plain `varchar(16)` with
 * no CHECK constraint (`AddListingMenu1821600000000`), so its new `shop` value
 * needs no change there.
 *
 * Data, for rows with `online = true` only (places keep their old tags): the
 * tags that became fields move into `online_details` and leave `tags`, the
 * hours note becomes the reply note, the website becomes the main link, and
 * the place categories map onto the online vocabulary. `city` is cleared to
 * `''`: the old write path stored `Lisbon` on every listing, so on an online
 * row it was never the owner's "Based in". `hood` and `address` are cleared,
 * `geocoded` set to false and the coordinates to `NULL`, the location values
 * the write path gives every online listing. The conversions live
 * in `src/database/listing-online-details-migration.ts`, frozen and pinned by
 * its spec. Rows are converted one at a time in TypeScript: online listings
 * are a small set, and a per-row conversion is one a spec can pin.
 *
 * `down` first moves every live `intimacy` (18+) listing back to `review`, the
 * moderation queue: the earlier code has no 18+ exclusion, and the category
 * map below drops `intimacy`, so such a listing would otherwise turn public.
 * A moderator decides on each one again. `down` then leaves `city` as `''`
 * and the location fields blank (the forced values carried no information to
 * restore), reverses the tag, hours-note and category moves, sets the `shop`
 * pricing mode the earlier code does not know back to `services`, then drops
 * the columns. The website copied into the main link stayed in `social`, so
 * there is nothing to put back for it.
 */
export class AddListingOnlineDetails1830100200000 implements MigrationInterface {
  name = 'AddListingOnlineDetails1830100200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "has_online_shop" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "online_details" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "shop_items" jsonb NOT NULL DEFAULT '[]'`,
    );

    const onlineRows: {
      id: string;
      cats: string[] | null;
      tags: string[] | null;
      hours_note: string | null;
      social: Record<string, unknown> | null;
    }[] = await queryRunner.query(
      `SELECT "id", "cats", "tags", "hours_note", "social" FROM "listings" WHERE "online" = true`,
    );
    for (const row of onlineRows) {
      const converted = convertOnlineListingRowUp({
        cats: row.cats,
        tags: row.tags,
        hoursNote: row.hours_note,
        social: row.social,
      });
      await queryRunner.query(
        `UPDATE "listings" SET "cats" = $1, "tags" = $2, "hours_note" = $3, "city" = $4, "hood" = $5, "address" = $6, "geocoded" = $7, "latitude" = $8, "longitude" = $9, "online_details" = $10::jsonb WHERE "id" = $11`,
        [
          converted.cats,
          converted.tags,
          converted.hoursNote,
          converted.city,
          converted.hood,
          converted.address,
          converted.geocoded,
          converted.latitude,
          converted.longitude,
          JSON.stringify(converted.onlineDetails),
          row.id,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The earlier code has no 18+ category and no 18+ exclusion, so a live
    // `intimacy` listing would turn public once the row loop below drops the
    // category. Back to the moderation queue first: `review` is left out of
    // every public read before and after this migration.
    await queryRunner.query(
      `UPDATE "listings" SET "status" = 'review' WHERE "status" = 'live' AND 'intimacy' = ANY("cats")`,
    );
    const onlineRows: {
      id: string;
      cats: string[] | null;
      tags: string[] | null;
      hours_note: string | null;
      online_details: unknown;
    }[] = await queryRunner.query(
      `SELECT "id", "cats", "tags", "hours_note", "online_details" FROM "listings" WHERE "online" = true`,
    );
    for (const row of onlineRows) {
      const restored = convertOnlineListingRowDown({
        cats: row.cats,
        tags: row.tags,
        hoursNote: row.hours_note,
        onlineDetails: row.online_details,
      });
      await queryRunner.query(
        `UPDATE "listings" SET "cats" = $1, "tags" = $2, "hours_note" = $3 WHERE "id" = $4`,
        [restored.cats, restored.tags, restored.hoursNote, row.id],
      );
    }
    await queryRunner.query(
      `UPDATE "listings" SET "pricing_mode" = 'services' WHERE "pricing_mode" = 'shop'`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "shop_items"`);
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "online_details"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "has_online_shop"`,
    );
  }
}
