import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill for the plain-text headline rule.
 *
 * `magazine_article.title` is declared plain text and is rendered as text
 * everywhere it is read (the article page, the archive list, global search, the
 * members' digest email, OG tags). The article editor's headline is an
 * uncontrolled contentEditable, though, and every save sent its raw
 * `innerHTML` — `<div>A <em>bold</em>&nbsp;claim</div>` — straight into the
 * column. `MagazinePieceService.updateArticleDraft` now normalises the value
 * once, at the write boundary (`toPlainText`), so no reader has to strip it
 * again; this migration applies the same normalisation to the rows written
 * before that, which would otherwise print literal tags to readers forever.
 *
 * The chain mirrors `toPlainText` exactly: tags out, character references
 * resolved, whitespace collapsed, trimmed. `&amp;` is decoded in a SEPARATE,
 * LATER statement on purpose — decoding it in the same pass as `&lt;` would
 * turn a doubly-encoded `&amp;lt;` into `<` instead of the literal `&lt;` a
 * single left-to-right pass produces. Numeric references (`&#8217;`) are left
 * alone here: they are vanishingly rare in a headline and worth less than the
 * risk of a hand-rolled SQL code-point decoder.
 *
 * `slug` is deliberately NOT touched. It was already derived from a stripped
 * copy of the title, and a published slug is a public URL that must stay
 * stable.
 *
 * `down()` cannot restore markup this deleted, and would not want to: the
 * previous value was a bug, not a state worth returning to.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class NormalizeMagazineArticleTitles1793540100000 implements MigrationInterface {
  name = 'NormalizeMagazineArticleTitles1793540100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "magazine_article"
      SET "title" = btrim(
        regexp_replace(
          replace(replace(replace(replace(replace(
            regexp_replace("title", '<[^>]*>', ' ', 'g'),
          '&nbsp;', ' '),
          '&quot;', '"'),
          '&apos;', ''''),
          '&#39;', ''''),
          '&lt;', '<'),
          '\\s+', ' ', 'g'
        )
      )
      WHERE "title" ~ '<[^>]*>'
         OR "title" ~ '&[a-zA-Z]+;'
         OR "title" ~ '&#[0-9]+;'
         OR "title" <> btrim(regexp_replace("title", '\\s+', ' ', 'g'))
    `);
    await queryRunner.query(`
      UPDATE "magazine_article"
      SET "title" = replace(replace("title", '&gt;', '>'), '&amp;', '&')
      WHERE "title" LIKE '%&gt;%' OR "title" LIKE '%&amp;%'
    `);

    // The desk board, the command palette and the piece record all read
    // `magazine_piece.title`, a plain-text mirror the service keeps in sync
    // with the article headline. It was derived with a tag-strip that replaced
    // each tag with a space and never collapsed the result, so mirrors of a
    // rich headline carry doubled spaces (and, for rows predating that strip,
    // the tags themselves).
    await queryRunner.query(`
      UPDATE "magazine_piece"
      SET "title" = btrim(
        regexp_replace(
          regexp_replace("title", '<[^>]*>', ' ', 'g'),
          '\\s+', ' ', 'g'
        )
      )
      WHERE "title" ~ '<[^>]*>'
         OR "title" <> btrim(regexp_replace("title", '\\s+', ' ', 'g'))
    `);
  }

  public async down(): Promise<void> {
    // Irreversible by nature: the markup this stripped is not recorded
    // anywhere, and re-introducing it would restore the bug rather than the
    // data. Left as an explicit no-op instead of a lie.
  }
}
