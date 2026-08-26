import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  ARTICLE_LOCALES,
  ArticleLocale,
} from '../entities/magazine-article.entity';

/**
 * `POST /magazine/admin/pieces/:id/article/translations` (CON-16).
 *
 * Opens a translation of an already-written piece as its OWN desk record: a
 * new `magazine_piece` and a new `magazine_article`, linked back to the
 * original. A translation is a commission like any other, so it gets a stage,
 * an editor, a thread and a publish date of its own, and it ships when the
 * translator is done rather than the moment the original does.
 */
export class CreateArticleTranslationDto {
  /** The language being translated INTO. Rejected when a translation in this
   *  language already exists (409) — one per language per piece. */
  @IsIn(ARTICLE_LOCALES)
  locale!: ArticleLocale;

  /**
   * The translator's name, as it should read in the credit line. Resolved to
   * a `magazine_author` byline the same way a writer's is, so the translator
   * gets an author page and a link from their member profile rather than a
   * string nobody can click.
   *
   * Optional: an editor can open the translation before deciding who will do
   * it, and credit them later from the article editor.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  translatorByline?: string;

  /** The member who will translate it, assigned as the new piece's writer.
   *  Also what links the translator's byline to their account when their
   *  display name matches `translatorByline`. */
  @IsOptional()
  @IsUUID()
  translatorUserId?: string;

  /**
   * Slug for the translated piece. Defaults to the original's slug suffixed
   * with the locale (`on-chosen-family-pt`), de-duplicated the same way every
   * other article slug is.
   *
   * A translation gets its own slug rather than a `?lang=` view of the
   * original's: it is a separate published piece with its own byline, its own
   * comments and its own shareable address, and a Portuguese reader sending a
   * Portuguese link to a friend should not have it open in English.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string;
}
