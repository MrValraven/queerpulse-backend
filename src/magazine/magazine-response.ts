import { toImageUrl } from '../common/image-url';
import {
  ArticleBlock,
  MagazineArticle,
} from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
import { DeckSlide, MagazineDeck } from './entities/magazine-deck.entity';
import { MagazineIssue } from './entities/magazine-issue.entity';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';

/**
 * Response shapes below mirror `queerpulse/src/shared/contracts/contracts.ts`
 * "--- Magazine ---" verbatim (field names, nullability, string dates) so the
 * eventual FE `magazine/*.api.ts` wiring is a drop-in.
 */

export interface AuthorSummary {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthorResponse {
  slug: string;
  name: string;
  bio: string | null;
  avatarUrl: string | null;
}

export interface IssueResponse {
  number: string;
  title: string;
  dek: string;
  publishedOn: string;
  coverUrl: string | null;
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
}

export interface StorySubmissionResponse {
  id: string;
  format: string;
  workingTitle: string;
  pitch: string;
  status: SubmissionStatus;
  createdAt: string;
}

export function toAuthorSummary(author: MagazineAuthor): AuthorSummary {
  return {
    handle: author.slug,
    displayName: author.name,
    avatarUrl: toImageUrl(author.avatarUrl),
  };
}

export function toAuthorResponse(author: MagazineAuthor): AuthorResponse {
  return {
    slug: author.slug,
    name: author.name,
    bio: author.bio,
    avatarUrl: toImageUrl(author.avatarUrl),
  };
}

export function toIssueResponse(issue: MagazineIssue): IssueResponse {
  return {
    number: issue.number,
    title: issue.title,
    dek: issue.dek,
    publishedOn: issue.publishedOn,
    coverUrl: toImageUrl(issue.coverUrl),
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
  };
}

export function toArticleResponse(
  article: MagazineArticle,
  author: MagazineAuthor,
  issueNumber: string | null,
): ArticleResponse {
  return {
    ...toArticleListItem(article, author, issueNumber),
    body: article.body,
    blocks: article.blocks,
    standfirst: article.standfirst,
    kicker: article.kicker,
    section: article.section,
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

export function toStorySubmissionResponse(
  submission: MagazineStorySubmission,
): StorySubmissionResponse {
  return {
    id: submission.id,
    format: submission.format,
    workingTitle: submission.workingTitle,
    pitch: submission.pitch,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
  };
}
