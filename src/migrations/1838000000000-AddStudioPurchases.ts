// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio purchases. A buyer pays an artist persona directly and records the
 * claim with "I've paid"; the artist confirms or declines it. No money moves
 * through QueerPulse.
 *
 * - `price_mode` and `price_cents` on `studio_releases` and `studio_tracks`:
 *   not for sale by default, a fixed price from 100 to 50000 cents, or a
 *   name-your-price minimum from 0 to 50000 cents.
 * - `studio_payment_methods`: up to eight ways to pay a persona (link,
 *   MB WAY, IBAN), in positions 0 to 7. They leave with the persona.
 * - `studio_purchases`: one row per claim. Snapshots (`artist_name`,
 *   `item_title`, `item_kind`) keep the record after the buyer, the persona,
 *   the release or the track is deleted. The release and track keys also set
 *   null on update, so a purchase never follows the re-key of a persona
 *   unlink to the pseudonymous persona.
 * - `studio_kept_tracks` and `studio_purchase_kept_tracks`: the tracks a
 *   confirmed buyer keeps after an unlink. Kept tracks hold no key into the
 *   catalog (no foreign key to `studio_tracks` or `subprofiles`).
 *
 * `down` drops the tables, the price checks and columns, then the five enum
 * types in reverse order.
 */
export class AddStudioPurchases1838000000000 implements MigrationInterface {
  name = 'AddStudioPurchases1838000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_price_mode" AS ENUM ('not_for_sale', 'fixed', 'name_your_price')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_payment_method_kind" AS ENUM ('link', 'mbway', 'iban')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_purchase_status" AS ENUM ('pending', 'confirmed', 'declined', 'cancelled', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_purchase_decline_reason" AS ENUM ('payment_not_found', 'amount_different', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_purchase_item_kind" AS ENUM ('release', 'track')`,
    );

    for (const tableName of ['studio_releases', 'studio_tracks']) {
      await queryRunner.query(
        `ALTER TABLE "${tableName}"
           ADD COLUMN "price_mode" "studio_price_mode" NOT NULL DEFAULT 'not_for_sale',
           ADD COLUMN "price_cents" integer,
           ADD CONSTRAINT "CHK_${tableName}_price" CHECK (
                ("price_mode" = 'not_for_sale' AND "price_cents" IS NULL)
             OR ("price_mode" = 'fixed' AND "price_cents" BETWEEN 100 AND 50000)
             OR ("price_mode" = 'name_your_price' AND "price_cents" BETWEEN 0 AND 50000)
           )`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE "studio_payment_methods" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subprofile_id" uuid NOT NULL,
        "kind" "studio_payment_method_kind" NOT NULL,
        "label" varchar(60),
        "value" varchar(500) NOT NULL,
        "note" varchar(160),
        "position" smallint NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_payment_methods" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_payment_methods_position" CHECK ("position" BETWEEN 0 AND 7),
        CONSTRAINT "FK_studio_payment_methods_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_payment_methods_subprofile_position" ON "studio_payment_methods" ("subprofile_id", "position")`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_purchases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "buyer_user_id" uuid,
        "subprofile_id" uuid,
        "artist_name" varchar(120) NOT NULL,
        "item_kind" "studio_purchase_item_kind" NOT NULL,
        "release_id" uuid,
        "track_id" uuid,
        "item_title" varchar(200) NOT NULL,
        "amount_cents" integer NOT NULL,
        "reference_code" char(6) NOT NULL,
        "payer_name" varchar(60),
        "status" "studio_purchase_status" NOT NULL DEFAULT 'pending',
        "decline_reason" "studio_purchase_decline_reason",
        "decline_note" varchar(200),
        "is_on_wall" boolean NOT NULL DEFAULT false,
        "is_shown_as_persona" boolean NOT NULL DEFAULT false,
        "shown_as_subprofile_id" uuid,
        "decided_by_user_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "decided_at" TIMESTAMP(3) WITH TIME ZONE,
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_purchases" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_purchases_item" CHECK (
             ("item_kind" = 'release' AND "track_id" IS NULL)
          OR ("item_kind" = 'track' AND "release_id" IS NULL)
        ),
        CONSTRAINT "CHK_studio_purchases_amount" CHECK ("amount_cents" BETWEEN 0 AND 50000),
        CONSTRAINT "CHK_studio_purchases_reference_code" CHECK ("reference_code" ~ '^[2-9A-HJKMNP-Z]{6}$'),
        CONSTRAINT "CHK_studio_purchases_decided" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
        CONSTRAINT "CHK_studio_purchases_decline" CHECK (("status" = 'declined') = ("decline_reason" IS NOT NULL)),
        CONSTRAINT "CHK_studio_purchases_decline_note" CHECK ("decline_note" IS NULL OR "status" = 'declined'),
        CONSTRAINT "CHK_studio_purchases_wall_identity" CHECK ("is_shown_as_persona" OR "shown_as_subprofile_id" IS NULL),
        CONSTRAINT "FK_studio_purchases_buyer" FOREIGN KEY ("buyer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_purchases_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_purchases_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE SET NULL ON UPDATE SET NULL,
        CONSTRAINT "FK_studio_purchases_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE SET NULL ON UPDATE SET NULL,
        CONSTRAINT "FK_studio_purchases_shown_as_subprofile" FOREIGN KEY ("shown_as_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_purchases_decided_by" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_purchases_reference_code" ON "studio_purchases" ("reference_code")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_purchases_pending_release" ON "studio_purchases" ("buyer_user_id", "release_id") WHERE "status" = 'pending' AND "release_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_purchases_pending_track" ON "studio_purchases" ("buyer_user_id", "track_id") WHERE "status" = 'pending' AND "track_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_buyer_created_at" ON "studio_purchases" ("buyer_user_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_subprofile_status_created_at" ON "studio_purchases" ("subprofile_id", "status", "created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_subprofile_decided_at" ON "studio_purchases" ("subprofile_id", "decided_at" DESC, "id" DESC) WHERE "status" = 'confirmed'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_release" ON "studio_purchases" ("release_id") WHERE "release_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_track" ON "studio_purchases" ("track_id") WHERE "track_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_shown_as" ON "studio_purchases" ("shown_as_subprofile_id") WHERE "shown_as_subprofile_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_decided_by" ON "studio_purchases" ("decided_by_user_id") WHERE "decided_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchases_pending_created_at" ON "studio_purchases" ("created_at") WHERE "status" = 'pending'`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_kept_tracks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "title" varchar(200) NOT NULL,
        "duration_seconds" integer,
        "audio_content_type" varchar(40) NOT NULL,
        "source_audio_key" varchar(500),
        "audio_key" varchar(500),
        "copy_attempts" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_kept_tracks" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_kept_tracks_audio" CHECK ("source_audio_key" IS NOT NULL OR "audio_key" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "studio_purchase_kept_tracks" (
        "purchase_id" uuid NOT NULL,
        "kept_track_id" uuid NOT NULL,
        "position" integer NOT NULL,
        CONSTRAINT "PK_studio_purchase_kept_tracks" PRIMARY KEY ("purchase_id", "kept_track_id"),
        CONSTRAINT "FK_studio_purchase_kept_tracks_purchase" FOREIGN KEY ("purchase_id") REFERENCES "studio_purchases"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_purchase_kept_tracks_kept_track" FOREIGN KEY ("kept_track_id") REFERENCES "studio_kept_tracks"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_purchase_kept_tracks_kept_track" ON "studio_purchase_kept_tracks" ("kept_track_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_purchase_kept_tracks"`);
    await queryRunner.query(`DROP TABLE "studio_kept_tracks"`);
    await queryRunner.query(`DROP TABLE "studio_purchases"`);
    await queryRunner.query(`DROP TABLE "studio_payment_methods"`);
    for (const tableName of ['studio_tracks', 'studio_releases']) {
      await queryRunner.query(
        `ALTER TABLE "${tableName}" DROP CONSTRAINT "CHK_${tableName}_price"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tableName}" DROP COLUMN "price_cents", DROP COLUMN "price_mode"`,
      );
    }
    await queryRunner.query(`DROP TYPE "studio_purchase_item_kind"`);
    await queryRunner.query(`DROP TYPE "studio_purchase_decline_reason"`);
    await queryRunner.query(`DROP TYPE "studio_purchase_status"`);
    await queryRunner.query(`DROP TYPE "studio_payment_method_kind"`);
    await queryRunner.query(`DROP TYPE "studio_price_mode"`);
  }
}
