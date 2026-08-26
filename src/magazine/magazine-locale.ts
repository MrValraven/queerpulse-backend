import {
  ARTICLE_LOCALES,
  ArticleLocale,
} from './entities/magazine-article.entity';

/**
 * CON-16 — narrows an arbitrary `?lang=` value to a locale the magazine
 * actually publishes in, or `null`.
 *
 * The value arrives from a query string, so it can be anything. `null` means
 * "no language preference expressed", which every caller treats as "serve
 * what you have" rather than as an error: a reader who lands on a shared link
 * carrying `?lang=fr` should get the piece, not a 400. A garbage locale is a
 * missing preference, never a missing article.
 *
 * Accepts the regional forms a browser or an `Accept-Language` header emits
 * (`pt-PT`, `en-GB`) by taking the primary subtag, so the frontend can hand
 * over `navigator.language` unmodified.
 */
export function toArticleLocale(value?: string | null): ArticleLocale | null {
  if (!value) return null;
  const primarySubtag = value.trim().toLowerCase().split('-')[0];
  return (
    ARTICLE_LOCALES.find((locale) => locale === primarySubtag) ??
    (null as ArticleLocale | null)
  );
}
