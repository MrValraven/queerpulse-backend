import type { MemberCard } from '../profiles/profile-response';
import type { DirectoryCardDTO } from '../listings/listing-response';
import type { CommunityCardDTO } from '../communities/community-response';
import type { EventSummary } from '../events/event-response';
import type { ForumThreadResponse } from '../forum/forum-response';
import type { ForumPostSearchRow } from '../forum/forum-posts.service';
import type { ArticleSearchRow } from '../magazine/magazine-response';
import type { JobSearchRow } from '../jobs/job-response';
import type { HousingSearchRow } from '../housing-listings/housing-listing-response';
import type { ResourceSearchRow } from '../resources/resource-response';
import type { SubprofileSearchRow } from '../subprofiles/subprofile-response';
import type { TopicSearchRow } from '../content/topic-response';
import { SearchResultType } from './dto/search.query';

export interface SearchResultDTO {
  type: `${SearchResultType}`;
  slug: string;
  name: string;
  sub: string;
  /** Member avatar URL, so the client can show a face instead of a generic icon. Member rows only. */
  avatarUrl?: string | null;
}

/**
 * `GET /search/types` — the result types search can currently answer with.
 *
 * Hand-mapped rather than returned raw: the registry behind it
 * (`RESULT_TYPE_FEATURE`) is keyed by result type but VALUED by internal
 * `FeatureKey` names, and there is no global serializer to strip them. The
 * client needs the result types, so those are all it gets.
 */
export interface SearchTypesDTO {
  /**
   * The launched result types, in the same order `search` groups them.
   * A type absent here runs no query and returns no rows, so a client
   * rendering one tab per type must leave it out rather than offer a tab
   * that can only ever be empty.
   */
  types: `${SearchResultType}`[];
}

export interface SearchResponseDTO {
  query: string;
  results: SearchResultDTO[];
  /**
   * True when the requested `type` has results beyond this page (SOC-08).
   * Always false on the unfiltered, all-types view, which caps each group at
   * six and points at the type's own tab instead of paging.
   */
  hasMore: boolean;
}

const joinSub = (...parts: (string | null | undefined)[]): string =>
  parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' · ');

export function memberToResult(card: MemberCard): SearchResultDTO {
  return {
    type: 'member',
    slug: card.slug,
    name: `${card.firstName} ${card.lastName}`.trim(),
    sub: joinSub(card.tagline, card.location),
    avatarUrl: card.avatarUrl,
  };
}

export function communityToResult(card: CommunityCardDTO): SearchResultDTO {
  return {
    type: 'community',
    slug: card.slug,
    name: card.name,
    sub: joinSub(card.type, `${card.memberCount} members`),
  };
}

export function eventToResult(card: EventSummary): SearchResultDTO {
  return {
    type: 'event',
    slug: card.slug,
    name: card.title,
    sub: joinSub(card.isOnline ? 'Online' : card.venue),
  };
}

export function forumToResult(thread: ForumThreadResponse): SearchResultDTO {
  return {
    type: 'forum',
    slug: thread.slug,
    name: thread.title,
    sub: joinSub(thread.category, `${thread.replyCount} replies`),
  };
}

/**
 * A reply-body hit. Named by its THREAD, because that is the page it opens and
 * the thing a member recognises; the `sub` carries the excerpt of the reply
 * that matched, which is the part that actually answered the question.
 */
export function forumPostToResult(row: ForumPostSearchRow): SearchResultDTO {
  return {
    type: 'forumPost',
    slug: row.threadSlug,
    name: row.threadTitle,
    sub: joinSub(row.excerpt),
  };
}

export function businessToResult(card: DirectoryCardDTO): SearchResultDTO {
  return {
    type: 'business',
    slug: card.slug,
    name: card.name,
    sub: joinSub(card.cat, card.hood),
  };
}

export function magazineToResult(row: ArticleSearchRow): SearchResultDTO {
  return {
    type: 'magazine',
    slug: row.slug,
    name: row.title,
    sub: joinSub(row.dek),
  };
}

export function jobToResult(row: JobSearchRow): SearchResultDTO {
  return {
    type: 'job',
    slug: row.slug,
    name: row.title,
    sub: joinSub(row.category, row.location),
  };
}

export function housingToResult(row: HousingSearchRow): SearchResultDTO {
  return {
    type: 'housing',
    slug: row.slug,
    name: row.title,
    sub: joinSub(row.area, row.city),
  };
}

export function resourceToResult(row: ResourceSearchRow): SearchResultDTO {
  return {
    type: 'resource',
    slug: row.slug,
    name: row.title,
    sub: joinSub(row.category),
  };
}

export function subprofileToResult(row: SubprofileSearchRow): SearchResultDTO {
  return {
    type: 'subprofile',
    // The persona's public handle is its /p/:handle identifier; the frontend
    // routes a subprofile hit through it (never an owner slug).
    slug: row.handle,
    name: row.displayName,
    sub: joinSub(row.tagline, row.kind),
  };
}

export function topicToResult(row: TopicSearchRow): SearchResultDTO {
  return {
    type: 'topic',
    // The tag IS the topic's routing slug (`topicPath()`/`TopicsService.loadOr404`
    // both key off it) — there's no separate slug field.
    slug: row.tag,
    // `#tag` mirrors the frontend's own `topicResponseToSearchItem` naming, so
    // the "jump to #tag" shortcut on the search page keeps matching by name.
    name: `#${row.tag}`,
    // Short factual metadata, matching every other type's `sub` — the full
    // `description` is a multi-sentence paragraph (see `topic.entity.ts`),
    // too long for a result-card subline.
    sub: joinSub(`${row.totalPosts} posts`),
  };
}
