import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-16 — a translation model for `magazine_article`.
 *
 * The chrome is genuinely bilingual (24k keys per locale, parity enforced by
 * test). The journalism was not: no article, deck, issue or author carried a
 * locale, there was no translation table and no `?lang=`. A Lisbon member who
 * switched the interface to Portuguese then read every piece in English.
 *
 * THE MODEL: SIBLING ROWS, NOT A TRANSLATIONS BLOB
 * A translated piece is a first-class article. It gets its own row, its own
 * slug, its own publish state, its own lifecycle, its own comments, and its
 * own place in the desk's workflow, because that is what it is: a piece of
 * work somebody did, which can be drafted, edited, published and later
 * archived independently of the original. Three columns make it a sibling
 * rather than a duplicate.
 *
 *  - `locale` — the language the row is WRITTEN IN. Every existing row takes
 *    the 'en' default, which is truthful: the archive was entirely English.
 *  - `translation_of_article_id` — the original, or NULL when this row IS the
 *    original. Browse lists filter on `IS NULL` so the archive shows each
 *    piece once and the reader's language choice picks which version they
 *    get; free-text search deliberately does not filter, because a Portuguese
 *    query can only ever match Portuguese text.
 *  - `translator_author_id` — the translator's byline. The `author_id` on a
 *    translation stays the ORIGINAL writer, because they wrote it. A
 *    translator is a second contributor who deserves a credit line of their
 *    own, which is why this points at `magazine_author` rather than storing a
 *    free-text name.
 *
 * THE PARTIAL UNIQUE INDEX
 * One translation per language per original. Partial (`WHERE
 * translation_of_article_id IS NOT NULL`) so the many originals all keep
 * their NULL without colliding with each other, which a plain unique index
 * over the pair would also allow but only by accident of NULL semantics; the
 * partial form says it on purpose and stays a smaller index. It also serves
 * the "does a `pt` sibling of this piece exist?" lookup behind `?lang=`.
 *
 * BOTH FKs ARE `ON DELETE SET NULL`, NOT CASCADE
 * Deleting an original must not silently delete its translations: they are
 * separate published pieces with their own readers and their own shared
 * links. An orphaned translation becomes a standalone article, which is
 * recoverable; a cascaded delete is not. Same reasoning for the translator
 * byline, matching `magazine_author.user_id`'s own SET NULL: erasing a
 * contributor's account unlinks the credit and leaves the published piece
 * standing.
 *
 * NOT TOUCHED: `search_vector`. It is a STORED generated column built with
 * the `'english'` regconfig, and a Portuguese row indexed under English
 * stemming still matches on whole words, just without Portuguese stemming.
 * Making the config per-row means a generation expression that reads another
 * column's value to pick a regconfig, which Postgres will not accept as
 * IMMUTABLE. A Portuguese search vector is its own follow-up (a second
 * generated column, or a `pg_trgm` fallback), and quietly rebuilding the
 * existing one here would be the wrong place for that decision.
 *
 * LOCKING
 * Three nullable/defaulted column adds on an editorial table of hundreds of
 * rows; the non-volatile `'en'` default is stored in the catalog rather than
 * rewriting the heap. Brief ACCESS EXCLUSIVE lock, plain transactional
 * migration.
 */
export class AddMagazineArticleTranslation1794833910000 implements MigrationInterface {
  name = 'AddMagazineArticleTranslation1794833910000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "locale" character varying(8) NOT NULL DEFAULT 'en'`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD CONSTRAINT "CHK_magazine_article_locale" CHECK ("locale" IN ('en', 'pt'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "translation_of_article_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD "translator_author_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD CONSTRAINT "FK_magazine_article_translation_of" FOREIGN KEY ("translation_of_article_id") REFERENCES "magazine_article"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" ADD CONSTRAINT "FK_magazine_article_translator_author" FOREIGN KEY ("translator_author_id") REFERENCES "magazine_author"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_translation_of" ON "magazine_article" ("translation_of_article_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_article_translation_locale" ON "magazine_article" ("translation_of_article_id", "locale") WHERE "translation_of_article_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "UQ_magazine_article_translation_locale"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_magazine_article_translation_of"`);
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "FK_magazine_article_translator_author"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "FK_magazine_article_translation_of"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "translator_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "translation_of_article_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "CHK_magazine_article_locale"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "locale"`,
    );
  }
}
