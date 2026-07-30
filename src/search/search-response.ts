import type { MemberCard } from '../profiles/profile-response';
import type { DirectoryCardDTO } from '../listings/listing-response';
import type { CommunityCardDTO } from '../communities/community-response';
import type { EventSummary } from '../events/event-response';
import type { ForumThreadResponse } from '../forum/forum-response';
import { SearchResultType } from './dto/search.query';

export interface SearchResultDTO {
  type: `${SearchResultType}`;
  slug: string;
  name: string;
  sub: string;
  /** Member avatar URL, so the client can show a face instead of a generic icon. Member rows only. */
  avatarUrl?: string | null;
}

export interface SearchResponseDTO {
  query: string;
  results: SearchResultDTO[];
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

export function businessToResult(card: DirectoryCardDTO): SearchResultDTO {
  return {
    type: 'business',
    slug: card.slug,
    name: card.name,
    sub: joinSub(card.cat, card.hood),
  };
}
