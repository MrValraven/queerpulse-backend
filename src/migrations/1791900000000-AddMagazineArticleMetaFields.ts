import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the article-editor's remaining round-trip fields to `magazine_article`
 * (CNT-1/CNT-2/CNT-7 audit follow-up): `role` (the contributor's credit-line
 * qualifier, e.g. "Contributing editor" — was editor-local-only, resetting on
 * reload, unlike the deck editor's equivalent `MagazineDeck.role` column) plus
 * three SEO fields the article editor had no backend support for at all
 * (`meta_description`, `social_image`, `canonical_url`). All four are plain
 * optional strings, defaulted to `''` like the entity's existing
 * `standfirst`/`kicker`/`section` columns, so every pre-existing row reads as
 * "not set" rather than `NULL`.
 *
 * Timestamp note: the plan that generated this migration specified
 * `1791700000000`, but that timestamp was already claimed by
 * `AddMemberRestriction1791700000000` (and `1791800000000` by
 * `AddCommunityGovernanceUnarchivedAction`) by the time this ran — used
 * `1791900000000` instead to avoid a collision.
 */
export class AddMagazineArticleMetaFields1791900000000 implements MigrationInterface {
  name = 'AddMagazineArticleMetaFields1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        ADD COLUMN "role" character varying NOT NULL DEFAULT '',
        ADD COLUMN "meta_description" character varying NOT NULL DEFAULT '',
        ADD COLUMN "social_image" character varying NOT NULL DEFAULT '',
        ADD COLUMN "canonical_url" character varying NOT NULL DEFAULT ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        DROP COLUMN "role",
        DROP COLUMN "meta_description",
        DROP COLUMN "social_image",
        DROP COLUMN "canonical_url"
    `);
  }
}
