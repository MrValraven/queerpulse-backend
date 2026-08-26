import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import {
  ArticleBlock,
  ArticleLifecycle,
  ArticleLocale,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { MagazineCorrection } from './entities/magazine-correction.entity';
import { DeckSlide, MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import { MagazineSection } from './entities/magazine-section.entity';
import {
  MagazineStorySubmission,
  SubmissionDecision,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';

/**
 * Response shapes below mirror `queerpulse/src/shared/contracts/contracts.ts`
 * "--- Magazine ---" verbatim (field names, nullability, string dates) so the
 * eventual FE `magazine/*.api.ts` wiring is a drop-in.
 */

/**
 * The member account a byline belongs to, resolved by the caller (CON-11).
 * `MagazineAuthor.userId` is the link; this is the profile behind it, loaded
 * in ONE batched lookup per page by the author reads in `MagazineService`.
 */
export interface AuthorMemberLink {
  memberSlug: string;
  memberName: string;
  /** Raw column value — mapped through `toImageUrl` by the mappers below. */
  memberAvatarUrl: string | null;
}

export interface AuthorSummary {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Member profile slug when this byline is linked to an account, `null`
   * otherwise. The FE byline links to `/members/<memberSlug>` when it is set
   * and falls back to the magazine author page when it is not.
   */
  memberSlug: string | null;
}

export interface AuthorResponse {
  slug: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
  /** See `AuthorSummary.memberSlug`. */
  memberSlug: string | null;
  /** Published pieces carrying this byline, for the authors directory card. */
  pieceCount: number;
}

export interface IssueResponse {
  number: string;
  title: string;
  dek: string;
  /** `YYYY-MM-DD`, or `null` while the issue is still unscheduled. */
  publishedOn: string | null;
  coverUrl: string | null;
  /** Crop rect for `coverUrl`, when a staff editor reframed it. */
  crop?: CropRect;
}

export interface ArticleListItem {
  slug: string;
  title: string;
  dek: string;
  author: AuthorSummary;
  issueNumber: string | null;
  tags: string[];
  readMinutes: number;
  publishedAt: string | null;
  /**
   * CON-16 — where this piece stands today. Carried on the LIST row too (not
   * only the detail read) so an archive card, an issue contents line and a
   * search result can all mark a piece as archived or superseded instead of
   * presenting a 2024 guide to name-change paperwork as current.
   */
  lifecycle: ArticleLifecycle;
  /** CON-16 — the language this row is written in. An issue is often only
   *  partly translated, so each card states its own language rather than the
   *  list stating one for all of them. */
  locale: ArticleLocale;
  /**
   * CON-04 — the piece's lead art, resolved from `MagazineArticle.heroImageKey`
   * through `toImageUrl`. `null` when the desk set none, in which case the
   * card keeps the tinted `ImageSlot` placeholder it has always had rather
   * than standing in a photograph nobody chose.
   */
  heroImageUrl: string | null;
}

/**
 * CON-16 — everything the dated lifecycle banner says beyond the state
 * itself, which the article response already carries as `lifecycle`.
 *
 * `changedAt` is the date in "dated banner": the reader is told when the desk
 * last looked at this piece, never left to infer it from the publish date. It
 * is `null` only for a piece that has never left `live`, where there is
 * nothing to date and no banner to draw.
 */
export interface ArticleLifecycleNotice {
  /** The editor's own sentence, or `''` when they left it blank and the
   *  banner falls back to the generic wording for the state. */
  note: string;
  /** ISO 8601 instant the piece entered this state, or `null`. */
  changedAt: string | null;
  /** The scheduled re-review as `YYYY-MM-DD`, or `null`. Served to the reader
   *  as well as the desk: "we will check this again in March" is a promise
   *  worth making in public. */
  reviewDueOn: string | null;
  /** The piece that replaces this one, when `state` is `superseded` and the
   *  replacement still exists. `null` otherwise. */
  supersededBy: { slug: string; title: string } | null;
}

/**
 * CON-16 — one language this piece is readable in, for the article page's
 * language switcher. The set always includes the piece the reader is on, so
 * a switcher can render the current language as the selected option without
 * a special case.
 */
export interface ArticleTranslationLink {
  locale: ArticleLocale;
  slug: string;
  title: string;
  /** `false` for a translation that is drafted but not yet published. The
   *  switcher shows it as in-progress rather than linking a reader to a 404. */
  isPublished: boolean;
}

/**
 * A published correction against the piece behind this article (CON-02). The
 * desk promises the reader "A correction is published as a dated note at the
 * foot of the piece. We never edit silently", so the note has to reach the
 * reader for that promise to be true.
 */
export interface ArticleCorrection {
  id: string;
  text: string;
  /** `YYYY-MM-DD`. The date the correction went up. */
  publishedOn: string;
}

export interface ArticleResponse extends ArticleListItem {
  body: string;
  /**
   * Block-based article body (Phase 3 / spec §7.3). Empty when the article
   * predates the block editor — the reader falls back to `body` in that case.
   */
  blocks: ArticleBlock[];
  standfirst: string;
  kicker: string;
  section: string;
  /**
   * CON-06 — the care-tab content notes. A piece cannot pass the publish gate
   * without at least one, and the reader is who they are for, so the article
   * read carries them.
   */
  contentNotes: string[];
  /** CON-02 — newest first. Empty for a piece that has never been corrected. */
  corrections: ArticleCorrection[];
  /**
   * CON-17 — the SEO rail's three fields, served so the editor's work reaches
   * the share card. Each is `''`/`null` when unset and the reader falls back
   * to the derived behaviour (first paragraph, hero image, route URL).
   */
  metaDescription: string;
  socialImage: string | null;
  canonicalUrl: string;
  /**
   * CON-16 — the rest of the dated lifecycle banner (the state itself is the
   * inherited `lifecycle` field). Always present; a `live` piece with no
   * review date draws no banner, which the reader experiences as the page it
   * has always been.
   */
  lifecycleNotice: ArticleLifecycleNotice;
  /**
   * CON-16 — every language this piece is readable in, including the one the
   * reader is currently on. One entry means there is no translation, which
   * the switcher states plainly rather than hiding.
   */
  translations: ArticleTranslationLink[];
  /** CON-16 — the ORIGINAL this piece was translated from, or `null` when
   *  this row is the original. Lets the reader get back to the source text. */
  translationOf: { locale: ArticleLocale; slug: string } | null;
  /** CON-16 — the translator's byline, on a translated piece. `null` on an
   *  original. The `author` field above stays the writer's, always. */
  translator: AuthorSummary | null;
  /**
   * CON-04 — the reframe crop saved for `heroImageUrl`, when a staff editor
   * reframed it. Same shape and same `media_crop` source as
   * `IssueResponse.crop`, and absent when the art was never reframed.
   *
   * The reader renders it as a FOCAL POINT, never as an exact frame: the hero
   * is a full-bleed banner whose box aspect does not match an arbitrary crop,
   * and `ImageSlot`'s `crop` prop would distort the art there (see the
   * `crop` vs `focus` contract on `ImageSlot`).
   */
  heroCrop?: CropRect;
}

/**
 * CNT-20 — the seeded section/topic taxonomy (`MagazineSection`), exposed
 * for the section browse page. `target`/`note` are the issue-planning
 * fields the entity docstring describes (spec §3.5 gap counts); harmless to
 * expose alongside `name`/`orderIndex` on this public read.
 */
export interface SectionResponse {
  id: string;
  name: string;
  target: number;
  note: string;
  orderIndex: number;
}

/**
 * The submitter's own view of a story they sent in. Carries the editorial
 * OUTCOME (CON-01): before, the tracker read "submitted" forever because
 * nothing could ever move the row. `decision` is the staff verdict and
 * `decisionNote` the reply they wrote back — the only prose the member gets
 * about it, since QueerPulse delivers no email.
 */
export interface StorySubmissionResponse {
  id: string;
  format: string;
  workingTitle: string;
  pitch: string;
  deck: string | null;
  coverUrl: string | null;
  status: SubmissionStatus;
  decision: SubmissionDecision | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/**
 * A byline's portrait: the author row's own `avatarUrl` when a staff editor
 * or the writer set one, otherwise the linked member's profile avatar. An
 * auto-created byline starts with `avatarUrl: null`, so without this fallback
 * a writer with a perfectly good member photo still renders as initials.
 */
function authorAvatarUrl(
  author: MagazineAuthor,
  link?: AuthorMemberLink | null,
): string | null {
  return toImageUrl(author.avatarUrl) ?? toImageUrl(link?.memberAvatarUrl);
}

export function toAuthorSummary(
  author: MagazineAuthor,
  link?: AuthorMemberLink | null,
): AuthorSummary {
  return {
    handle: author.slug,
    displayName: author.name,
    avatarUrl: authorAvatarUrl(author, link),
    memberSlug: link?.memberSlug ?? null,
  };
}

export function toAuthorResponse(
  author: MagazineAuthor,
  link?: AuthorMemberLink | null,
  pieceCount = 0,
): AuthorResponse {
  return {
    slug: author.slug,
    name: author.name,
    bio: author.bio,
    avatarUrl: authorAvatarUrl(author, link),
    memberSlug: link?.memberSlug ?? null,
    pieceCount,
  };
}

export function toIssueResponse(
  issue: MagazineIssue,
  // Pre-loaded crop lookup — the caller batches ONE `MediaCropService.getMany`
  // and passes the resulting Map straight through; this mapper stays
  // synchronous.
  crops: Map<string, CropRect> = new Map(),
): IssueResponse {
  return {
    number: issue.number,
    title: issue.title,
    dek: issue.dek,
    publishedOn: issue.publishedOn,
    coverUrl: toImageUrl(issue.coverUrl),
    crop: cropFor(issue.coverUrl, crops),
  };
}

export function toArticleListItem(
  article: MagazineArticle,
  author: MagazineAuthor,
  issueNumber: string | null,
): ArticleListItem {
  return {
    slug: article.slug,
    title: article.title,
    dek: article.dek,
    author: toAuthorSummary(author),
    issueNumber,
    tags: article.tags,
    readMinutes: article.readMinutes,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    // CON-16. Both columns are NOT NULL with defaults, but a projected
    // `select([...])` that predates them hands the mapper `undefined` rather
    // than throwing, so each falls back to what every pre-CON-16 row is.
    lifecycle: article.lifecycle ?? 'live',
    locale: article.locale ?? 'en',
    // CON-04. Same `select([...])` caveat as the two columns above: a
    // projection that predates the column hands the mapper `undefined`, which
    // reads as "no art" rather than throwing.
    heroImageUrl: toImageUrl(article.heroImageKey),
  };
}

/**
 * CON-16 — the entity's lifecycle columns as the reader-facing banner shape. `supersededBy` is passed in rather than looked up here: the mapper
 * stays synchronous and the caller batches the one extra row it needs.
 */
export function toArticleLifecycleNotice(
  article: MagazineArticle,
  supersededBy: MagazineArticle | null = null,
): ArticleLifecycleNotice {
  return {
    note: article.lifecycleNote ?? '',
    changedAt: article.lifecycleChangedAt
      ? article.lifecycleChangedAt.toISOString()
      : null,
    reviewDueOn: article.reviewDueOn ?? null,
    supersededBy: supersededBy
      ? { slug: supersededBy.slug, title: supersededBy.title }
      : null,
  };
}

/**
 * CON-16 — one language option for the article page's switcher.
 * `isPublished` uses the same gate every public read does (`published_at`
 * set and not in the future), so a translation that is drafted but unshipped
 * is offered as in-progress instead of as a link to a 404.
 */
export function toArticleTranslationLink(
  article: MagazineArticle,
): ArticleTranslationLink {
  return {
    locale: article.locale ?? 'en',
    slug: article.slug,
    title: article.title,
    isPublished:
      article.publishedAt !== null && article.publishedAt <= new Date(),
  };
}

/**
 * CON-04 — an article's blocks with every image block's `src` resolved for
 * reading.
 *
 * The block editor persists whatever reference it was given: an uploaded
 * storage key (what the block's picker now produces) or an `https://` URL on a
 * trusted host (what the old paste-a-URL field produced). A storage key is not
 * fetchable — the bucket is private and reads go through `GET /files/<key>` —
 * so a key handed to a browser verbatim renders as a broken image inside the
 * body of the piece.
 *
 * Applied at every read boundary that serves `blocks` (the public article and
 * the desk's own draft), never at the write boundary: the column stays
 * canonical keys, and a resolved URL that comes back on the next save is
 * collapsed to its key again by the global `StorageKeyOwnershipInterceptor`.
 *
 * Non-image blocks are returned by reference, so this allocates a new object
 * only for the blocks it actually rewrites.
 */
export function toReadableBlocks(blocks: ArticleBlock[]): ArticleBlock[] {
  return (blocks ?? []).map((block) => {
    if (block.kind !== 'image' || !block.src) {
      return block;
    }
    // `toImageUrl` drops anything that is neither one of our keys nor an
    // https URL; an unrenderable reference becomes "no image", which the
    // reader already handles as the block's tinted placeholder.
    return { ...block, src: toImageUrl(block.src) ?? undefined };
  });
}

export function toArticleCorrection(
  correction: MagazineCorrection,
): ArticleCorrection {
  return {
    id: correction.id,
    // A correction row always carries a date (the desk defaults it to today
    // when the editor leaves it blank), so fall back to the row's own creation
    // day rather than handing the reader an undated note.
    publishedOn:
      correction.publishedOn ?? correction.createdAt.toISOString().slice(0, 10),
    text: correction.text,
  };
}

/**
 * CON-16 — the rows the article read resolves alongside the piece itself.
 * Passed in rather than fetched here so `toArticleResponse` stays a pure
 * synchronous mapper and the service batches the lookups (see
 * `MagazineService.getArticleBySlug`).
 */
export interface ArticleResponseExtras {
  /** The replacement piece, when this one is `superseded`. */
  supersededBy?: MagazineArticle | null;
  /** Every sibling language of this piece, EXCLUDING the piece itself — the
   *  mapper adds the current row to the switcher list on its own. */
  siblings?: MagazineArticle[];
  /** The original this row translates, when it is a translation. */
  translationOf?: MagazineArticle | null;
  /** The translator's byline, when this row is a translation. */
  translator?: MagazineAuthor | null;
  /**
   * CON-04 — pre-loaded reframe crops, keyed by bare storage key. The caller
   * batches ONE `MediaCropService.getMany` and passes the resulting Map
   * straight through, exactly as `toIssueResponse` takes it, so this mapper
   * stays synchronous.
   */
  crops?: Map<string, CropRect>;
}

/** Shared empty lookup for reads that carry no crops, so the mapper never
 *  allocates one per call. */
const EMPTY_CROPS: Map<string, CropRect> = new Map();

export function toArticleResponse(
  article: MagazineArticle,
  author: MagazineAuthor,
  issueNumber: string | null,
  corrections: MagazineCorrection[] = [],
  extras: ArticleResponseExtras = {},
): ArticleResponse {
  // The switcher always offers the language the reader is already in, so it
  // can render a selected option without a special case, and so a piece with
  // no translation still says which language it IS rather than showing an
  // empty control.
  const translations = [
    toArticleTranslationLink(article),
    ...(extras.siblings ?? []).map(toArticleTranslationLink),
  ].sort((left, right) => left.locale.localeCompare(right.locale));

  return {
    ...toArticleListItem(article, author, issueNumber),
    body: article.body,
    // CON-04. An image block's `src` is a STORAGE KEY once an editor uploads
    // the art through the block's picker, and a private key is not fetchable —
    // rendering it raw would print a broken image into the middle of the
    // piece. Resolved here, at the one read boundary, the same way every other
    // image column on this response is.
    blocks: toReadableBlocks(article.blocks),
    standfirst: article.standfirst,
    kicker: article.kicker,
    section: article.section,
    contentNotes: article.contentNotes ?? [],
    corrections: corrections.map(toArticleCorrection),
    metaDescription: article.metaDescription,
    // Runs through `toImageUrl` like every other image column: resolves a
    // storage key to our `/files/*` route and drops anything that is neither a
    // key nor an https URL.
    socialImage: toImageUrl(article.socialImage),
    canonicalUrl: article.canonicalUrl,
    lifecycleNotice: toArticleLifecycleNotice(
      article,
      extras.supersededBy ?? null,
    ),
    translations,
    translationOf: extras.translationOf
      ? {
          locale: extras.translationOf.locale ?? 'en',
          slug: extras.translationOf.slug,
        }
      : null,
    translator: extras.translator ? toAuthorSummary(extras.translator) : null,
    heroCrop: cropFor(article.heroImageKey, extras.crops ?? EMPTY_CROPS),
  };
}

/**
 * Lightweight row for the cross-entity global search (`SearchService`) — just
 * the fields the search-result card needs, so a magazine hit never has to
 * hydrate its author/issue. Mapped to a `SearchResultDTO` by hand in
 * `search/search-response.ts` (no column leakage).
 */
export interface ArticleSearchRow {
  slug: string;
  title: string;
  dek: string;
}

export function toArticleSearchRow(article: MagazineArticle): ArticleSearchRow {
  return {
    slug: article.slug,
    title: article.title,
    dek: article.dek,
  };
}

/**
 * `id` is included (unlike `ArticleListItem`/`ArticleResponse` above) because
 * the sub-project 3 authoring UI loads a deck for editing by uuid, not slug.
 * Exposing it on the public read is harmless — the reader keys off `slug`.
 */
export interface DeckListItemResponse {
  id: string;
  slug: string;
  title: string;
  kicker: string;
  section: string;
  byline: string;
  role: string | null;
  readTime: string;
  cover: string;
  coverDesc: string;
  tags: string[];
  publishedAt: string | null;
}

export interface DeckResponse extends DeckListItemResponse {
  authorBio: string;
  related: string[];
  slides: DeckSlide[];
}

export function toDeckListItem(deck: MagazineDeck): DeckListItemResponse {
  return {
    id: deck.id,
    slug: deck.slug,
    title: deck.title,
    kicker: deck.kicker,
    section: deck.section,
    byline: deck.byline,
    role: deck.role,
    readTime: deck.readTime,
    cover: deck.cover,
    coverDesc: deck.coverDesc,
    tags: deck.tags,
    publishedAt: deck.publishedAt ? deck.publishedAt.toISOString() : null,
  };
}

export function toDeckResponse(deck: MagazineDeck): DeckResponse {
  return {
    ...toDeckListItem(deck),
    authorBio: deck.authorBio,
    related: deck.related,
    slides: deck.slides,
  };
}

export function toSectionResponse(section: MagazineSection): SectionResponse {
  return {
    id: section.id,
    name: section.name,
    target: section.target,
    note: section.note,
    orderIndex: section.orderIndex,
  };
}

export function toStorySubmissionResponse(
  submission: MagazineStorySubmission,
): StorySubmissionResponse {
  return {
    id: submission.id,
    format: submission.format,
    workingTitle: submission.workingTitle,
    pitch: submission.pitch,
    deck: submission.deck,
    // The member's own cover, served as a URL rather than the raw key. The
    // full `body` is deliberately absent: the tracker card shows a summary,
    // and re-serving the whole piece on every list read costs bandwidth for
    // text the member already has.
    coverUrl: toImageUrl(submission.coverImageKey),
    status: submission.status,
    decision: submission.decision,
    decisionNote: submission.decisionNote,
    decidedAt: submission.decidedAt ? submission.decidedAt.toISOString() : null,
    createdAt: submission.createdAt.toISOString(),
  };
}
