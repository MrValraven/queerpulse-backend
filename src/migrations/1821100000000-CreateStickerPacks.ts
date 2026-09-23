// DO NOT RUN. This migration has not been applied to any environment yet.
// Remove this banner in the same change that applies it.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sticker catalogue: admin-built packs and the stickers inside them.
 *
 * `svg_source` holds the re-editable artwork as markup and `template_params`
 * the exact inputs that produced it, so a sticker can be re-rendered later
 * without the admin rebuilding it by hand. Only the rasterised PNG lives in
 * the bucket (`storage_key`): the upload content-type allow-list admits no
 * SVG, and serving member-reachable SVG from `GET /files/*` would be an XSS
 * vector.
 *
 * `cover_sticker_id` deliberately carries NO foreign key. It points into the
 * child table, and a real constraint would make the two tables circular for
 * insert ordering; the read path treats an unresolvable cover as "no cover".
 */
export class CreateStickerPacks1821100000000 implements MigrationInterface {
  name = 'CreateStickerPacks1821100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "sticker_packs_status_enum" AS ENUM ('draft', 'published', 'archived')`,
    );
    await queryRunner.query(`
      CREATE TABLE "sticker_packs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" character varying(64) NOT NULL,
        "name" character varying(80) NOT NULL,
        "description" text,
        "status" "sticker_packs_status_enum" NOT NULL DEFAULT 'draft',
        "sort_order" integer NOT NULL DEFAULT 0,
        "cover_sticker_id" uuid,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sticker_packs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sticker_packs_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_sticker_packs_created_by" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_sticker_packs_status_order"
        ON "sticker_packs" ("status", "sort_order")
    `);
    await queryRunner.query(`
      CREATE TABLE "stickers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "pack_id" uuid NOT NULL,
        "slug" character varying(64) NOT NULL,
        "label" character varying(80) NOT NULL,
        "storage_key" character varying(512) NOT NULL,
        "width" integer NOT NULL,
        "height" integer NOT NULL,
        "svg_source" text NOT NULL,
        "template_id" character varying(64) NOT NULL,
        "template_params" jsonb NOT NULL,
        "keywords" jsonb NOT NULL DEFAULT '{"en":[],"pt":[]}',
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stickers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_stickers_pack_slug" UNIQUE ("pack_id", "slug"),
        CONSTRAINT "FK_stickers_pack" FOREIGN KEY ("pack_id")
          REFERENCES "sticker_packs"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_stickers_pack_order"
        ON "stickers" ("pack_id", "sort_order")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_stickers_pack_order"`);
    await queryRunner.query(`DROP TABLE "stickers"`);
    await queryRunner.query(`DROP INDEX "IDX_sticker_packs_status_order"`);
    await queryRunner.query(`DROP TABLE "sticker_packs"`);
    await queryRunner.query(`DROP TYPE "sticker_packs_status_enum"`);
  }
}
