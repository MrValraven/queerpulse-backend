import { MagazineArticle } from './entities/magazine-article.entity';
import { MagazineAuthor } from './entities/magazine-author.entity';
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
    avatarUrl: author.avatarUrl,
  };
}

export function toAuthorResponse(author: MagazineAuthor): AuthorResponse {
  return {
    slug: author.slug,
    name: author.name,
    bio: author.bio,
    avatarUrl: author.avatarUrl,
  };
}

export function toIssueResponse(issue: MagazineIssue): IssueResponse {
  return {
    number: issue.number,
    title: issue.title,
    dek: issue.dek,
    publishedOn: issue.publishedOn,
    coverUrl: issue.coverUrl,
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
