import type { StudioArtistRef } from './studio-response';
import type { StudioPlaylistEntryTrack } from './studio-playlist-response';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';

/** The windows a listener can read their own summary over. */
export const STUDIO_LISTENING_RANGES = ['4w', '6m', '12m'] as const;

export type StudioListeningRange = (typeof STUDIO_LISTENING_RANGES)[number];

export const DEFAULT_STUDIO_LISTENING_RANGE: StudioListeningRange = '4w';

/** Postgres interval text for each range, bound as `$n::interval`. */
export const STUDIO_LISTENING_RANGE_INTERVALS: Record<
  StudioListeningRange,
  string
> = { '4w': '28 days', '6m': '6 months', '12m': '12 months' };

/** Rows shown in each top list. */
export const STUDIO_LISTENING_TOP_SHOWN = 10;

/** Listens per page of the recent list. */
export const STUDIO_LISTENS_PER_PAGE = 30;

/** Listening history older than this is pruned. */
export const STUDIO_LISTENING_RETENTION_INTERVAL = '13 months';

export interface StudioListeningTopArtist {
  artist: StudioArtistRef;
  listens: number;
}

export interface StudioListeningTopTrack {
  track: StudioPlaylistEntryTrack;
  listens: number;
}

/** GET /me/studio-listening: the caller's own totals, with no privacy floor. */
export interface StudioListeningSummary {
  range: StudioListeningRange;
  totalListens: number;
  listeningDays: number;
  topArtists: StudioListeningTopArtist[];
  topTracks: StudioListeningTopTrack[];
}

export interface StudioListen {
  id: string;
  /** ISO, millisecond precision. */
  playedAt: string;
  /** Null when the caller cannot play the track now. */
  track: StudioPlaylistEntryTrack | null;
}

/** GET /me/studio-listening/recent. */
export interface StudioListensPage {
  items: StudioListen[];
  nextCursor: string | null;
}

/** The recent list's keyset position: the last listen a page returned. */
export interface StudioListenCursor {
  playedAt: Date;
  id: string;
}

/** Same wire shape as the home feed cursor, with `playedAt` as the time. */
export function encodeListenCursor(cursor: StudioListenCursor): string {
  return encodeStudioCursor({
    publishedAt: cursor.playedAt,
    id: cursor.id,
  });
}

/** Never throws: anything malformed reads as the first page. */
export function decodeListenCursor(
  cursor: string | undefined,
): StudioListenCursor | null {
  const decoded = decodeStudioCursor(cursor);
  return decoded ? { playedAt: decoded.publishedAt, id: decoded.id } : null;
}
