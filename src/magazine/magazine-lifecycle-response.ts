import {
  ArticleLifecycle,
  ArticleLocale,
  MagazineArticle,
} from './entities/magazine-article.entity';

/**
 * CON-16 — one published piece as the lifecycle desk sees it: where it
 * stands, when the desk last said so, and when it has promised to look again.
 *
 * Distinct from the reader-facing `ArticleLifecycleNotice` on the article
 * response: this carries the desk's own handles (`pieceId`, so a row opens in
 * the editor) and the derived `reviewDueInDays` an editor triages by.
 */
export interface ArticleLifecycleRecord {
  articleId: string;
  /** The desk record this article belongs to, so a row can open in the piece
   *  editor. `null` for an article with no piece behind it (an imported or
   *  seeded row), which is readable but not editable at the desk. */
  pieceId: string | null;
  slug: string;
  title: string;
  section: string;
  /** ISO 8601, or `null` for a piece that is not live. */
  publishedAt: string | null;
  lifecycle: ArticleLifecycle;
  lifecycleNote: string;
  /** ISO 8601 instant the piece entered its current state, or `null`. */
  lifecycleChangedAt: string | null;
  /** `YYYY-MM-DD`, or `null` when no re-review is scheduled. */
  reviewDueOn: string | null;
  /**
   * Whole days from today to `reviewDueOn`. NEGATIVE means overdue, which is
   * the number an editor triages by, so it is computed once here rather than
   * in every client that renders a queue. `null` when nothing is scheduled.
   */
  reviewDueInDays: number | null;
  /** The replacement piece, when this one is superseded and it still exists. */
  supersededBy: { slug: string; title: string } | null;
  locale: ArticleLocale;
  /** The original, when this row is a translation. */
  translationOfSlug: string | null;
}

/**
 * CON-16 — the lifecycle desk in one read: what is due, what is already
 * flagged, and the standing tally.
 *
 * Two lists rather than one, because they answer different questions.
 * `dueForReview` is a WORK QUEUE: pieces whose promised re-review date has
 * arrived (or is close), oldest promise first, and most of them are still
 * `live` because nobody has looked yet. `flagged` is the current public
 * STATE of the archive: everything a reader would see a banner on. A piece
 * can be in both.
 */
export interface LifecycleDeskResponse {
  dueForReview: ArticleLifecycleRecord[];
  flagged: ArticleLifecycleRecord[];
  counts: LifecycleCounts;
}

export interface LifecycleCounts {
  live: number;
  underReview: number;
  archived: number;
  superseded: number;
  /** Pieces whose promised re-review date has already passed. */
  overdue: number;
}

/**
 * CON-16 — a translation the desk just created, or one it already had. Enough
 * for the caller to open it in the piece editor; the full draft comes from
 * the existing `GET /magazine/admin/pieces/:id/article`.
 */
export interface ArticleTranslationRecord {
  articleId: string;
  pieceId: string | null;
  slug: string;
  title: string;
  locale: ArticleLocale;
  publishedAt: string | null;
  /** The translator's byline slug, when one was credited. */
  translatorSlug: string | null;
}

/** Whole days from today (UTC) to a `YYYY-MM-DD` date. Negative when past. */
export function daysUntil(
  isoDate: string | null,
  today = new Date(),
): number | null {
  if (!isoDate) return null;
  const due = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(due)) return null;
  const startOfToday = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.round((due - startOfToday) / 86_400_000);
}

export function toArticleLifecycleRecord(
  article: MagazineArticle,
  pieceId: string | null,
  supersededBy: MagazineArticle | null,
  translationOf: MagazineArticle | null,
  today = new Date(),
): ArticleLifecycleRecord {
  return {
    articleId: article.id,
    pieceId,
    slug: article.slug,
    title: article.title,
    section: article.section,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    lifecycle: article.lifecycle ?? 'live',
    lifecycleNote: article.lifecycleNote ?? '',
    lifecycleChangedAt: article.lifecycleChangedAt
      ? article.lifecycleChangedAt.toISOString()
      : null,
    reviewDueOn: article.reviewDueOn ?? null,
    reviewDueInDays: daysUntil(article.reviewDueOn ?? null, today),
    supersededBy: supersededBy
      ? { slug: supersededBy.slug, title: supersededBy.title }
      : null,
    locale: article.locale ?? 'en',
    translationOfSlug: translationOf ? translationOf.slug : null,
  };
}
