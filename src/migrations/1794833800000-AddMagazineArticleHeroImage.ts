// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_article.hero_image_key` — the piece's lead art (CON-04).
 *
 * The magazine had no image column at all: every live card rendered a tinted
 * `ImageSlot` placeholder and every article's 480px hero strip was an empty
 * tint, on a product where photography and illustration are half the point.
 * The SEO rail's `social_image` was the closest thing, and it is a different
 * editorial decision (the share-card override), so reading it as the page's
 * art conflated the two.
 *
 * `NOT NULL DEFAULT ''` matches every other optional image/text column on this
 * table (`social_image`, `canonical_url`, `kicker`, `standfirst`), so an
 * article with no art reads as the empty string rather than as `NULL` and no
 * read path needs a null check it does not already have.
 *
 * No crop column: the reframe crop for this key lives in `media_crop`, keyed
 * by the storage key, exactly like the issue cover's and every other reframed
 * upload in the app.
 *
 * `IF NOT EXISTS` / `IF EXISTS` so a re-run is a no-op rather than an error.
 */
export class AddMagazineArticleHeroImage1794833800000 implements MigrationInterface {
  name = 'AddMagazineArticleHeroImage1794833800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD COLUMN IF NOT EXISTS "hero_image_key" character varying NOT NULL DEFAULT ''`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN IF EXISTS "hero_image_key"`,
    );
  }
}
