import { toImageUrl } from '../../common/image-url';
import type {
  FeedEntryStatus,
  SubprofileFeedEntry,
} from '../entities/subprofile-feed-entry.entity';
import type {
  FeedErrorCode,
  SubprofileFeed,
} from '../entities/subprofile-feed.entity';
import type { SubprofileView } from '../subprofile-response';
import type { ParsedEpisode } from './feed-parse';
import { feedStatus } from './feed-schedule';

/**
 * Response shapes for persona feed import (the shared API contract, v1).
 * Hand-mapped: neither the remote show art nor any remote episode art URL is
 * ever put on the wire, only the resolved URL of OUR stored copy.
 */

export interface SubprofileFeedDTO {
  id: string;
  subprofileId: string;
  feedUrl: string;
  section: string;
  title: string | null;
  author: string | null;
  imageUrl: string | null;
  autoPublish: boolean;
  status: 'active' | 'failing';
  lastSyncedAt: string | null;
  lastError: FeedErrorCode | null;
  pendingCount: number;
  publishedCount: number;
  createdAt: string;
}

export interface FeedEpisodeFields {
  guid: string;
  title: string;
  description: string | null;
  link: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  season: number | null;
  episode: number | null;
}

export interface FeedPreviewDTO {
  feedUrl: string;
  title: string;
  author: string | null;
  description: string | null;
  episodeCount: number;
  latest: FeedEpisodeFields[];
  alreadyConnected: boolean;
}

export interface FeedEntryDTO extends FeedEpisodeFields {
  id: string;
  feedId: string;
  status: FeedEntryStatus;
  itemId: string | null;
  createdAt: string;
}

export interface PublishFeedEntriesResponse {
  published: number;
  skipped: number;
  subprofile: SubprofileView;
}

export interface FeedEntryCounts {
  pending: number;
  published: number;
}

export function toFeedDTO(
  feed: SubprofileFeed,
  counts: FeedEntryCounts,
): SubprofileFeedDTO {
  return {
    id: feed.id,
    subprofileId: feed.subprofileId,
    feedUrl: feed.feedUrl,
    section: feed.section,
    title: feed.title,
    author: feed.author,
    imageUrl: toImageUrl(feed.imageKey),
    autoPublish: feed.autoPublish,
    status: feedStatus(feed.consecutiveFailures),
    lastSyncedAt: feed.lastSyncedAt ? feed.lastSyncedAt.toISOString() : null,
    lastError: feed.lastError,
    pendingCount: counts.pending,
    publishedCount: counts.published,
    createdAt: feed.createdAt.toISOString(),
  };
}

/** A parsed episode as preview fields. `imageUrl` is deliberately dropped. */
export function toEpisodeFields(episode: ParsedEpisode): FeedEpisodeFields {
  return {
    guid: episode.guid,
    title: episode.title,
    description: episode.description,
    link: episode.link,
    publishedAt: episode.publishedAt ? episode.publishedAt.toISOString() : null,
    durationSeconds: episode.durationSeconds,
    season: episode.season,
    episode: episode.episode,
  };
}

/** A stored entry as the review list shows it. `remoteImageUrl` stays
 *  server-side. */
export function toEntryDTO(entry: SubprofileFeedEntry): FeedEntryDTO {
  return {
    id: entry.id,
    feedId: entry.feedId,
    guid: entry.guid,
    title: entry.title,
    description: entry.description,
    link: entry.link,
    publishedAt: entry.publishedAt ? entry.publishedAt.toISOString() : null,
    durationSeconds: entry.durationSeconds,
    season: entry.season,
    episode: entry.episode,
    status: entry.status,
    itemId: entry.itemId,
    createdAt: entry.createdAt.toISOString(),
  };
}
