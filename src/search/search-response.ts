import type { MemberCard } from '../profiles/profile-response';
import type { DirectoryCardDTO } from '../listings/listing-response';
import type { CommunityCardDTO } from '../communities/community-response';
import type { EventSummary } from '../events/event-response';
import type { ForumThreadResponse } from '../forum/forum-response';
import type { ArticleSearchRow } from '../magazine/magazine-response';
import type { JobSearchRow } from '../jobs/job-response';
import type { HousingSearchRow } from '../housing-listings/housing-listing-response';
import type { ResourceSearchRow } from '../resources/resource-response';
import type { WorkshopSearchRow } from '../workshops/workshop-response';
import type { SubprofileSearchRow } from '../subprofiles/subprofile-response';
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

export function workshopToResult(row: WorkshopSearchRow): SearchResultDTO {
  return {
    type: 'workshop',
    slug: row.slug,
    name: row.title,
    sub: joinSub(row.cat),
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
