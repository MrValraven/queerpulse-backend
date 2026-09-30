import { isSafeUrlValue } from '../../common/validators/is-safe-url.decorator';
import type { TopInsertItemFields } from '../subprofiles.service';
import { truncateText } from './feed-parse';

/**
 * How a feed episode becomes a persona item (the contract's "Publishing an
 * entry -> item mapping"). Pure, so every rule is unit-tested.
 *
 * The caps mirror `SubprofileItemInputDTO`, the body a section save validates,
 * so an imported item is always one the editor could save back unchanged.
 */
export const ITEM_TITLE_MAX = 200;
export const ITEM_DESCRIPTION_MAX = 5000;
export const ITEM_URL_MAX = 1000;
export const ITEM_META_MAX = 200;

export interface EpisodeForItem {
  title: string;
  description: string | null;
  link: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  season: number | null;
  episode: number | null;
}

/** `"S2 · E14"` with both numbers, `"E14"` with only the episode, else null. */
export function episodeSubtitle(
  season: number | null,
  episode: number | null,
): string | null {
  if (episode === null) return null;
  return season !== null ? `S${season} · E${episode}` : `E${episode}`;
}

/** `"48 min"` / `"1 h 12 min"` / `"2 h"`, rounded to the minute (a clip under
 *  a minute reads `"1 min"`), else null. */
export function formatDurationMeta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** The editor's month format, `yyyy-mm` (UTC), else null. */
export function monthOf(date: Date | null): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1000 || year > 9999) return null;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** The episode link when a section save would accept it (`https:`, within the
 *  item URL cap), else null. A plain `http:` link is dropped, exactly as the
 *  `@IsSafeUrl` rule on the section save would refuse it. */
export function safeItemUrl(link: string | null): string | null {
  if (!link || link.length > ITEM_URL_MAX) return null;
  return isSafeUrlValue(link) ? link : null;
}

/** The item a published episode becomes. `imageKey` is OUR stored copy of the
 *  episode (or show) art, never the remote URL. */
export function episodeToItemFields(
  episode: EpisodeForItem,
  imageKey: string | null,
): TopInsertItemFields {
  const meta = formatDurationMeta(episode.durationSeconds);
  return {
    title: truncateText(episode.title, ITEM_TITLE_MAX),
    subtitle: episodeSubtitle(episode.season, episode.episode),
    description: episode.description
      ? truncateText(episode.description, ITEM_DESCRIPTION_MAX)
      : null,
    url: safeItemUrl(episode.link),
    date: monthOf(episode.publishedAt),
    meta: meta ? truncateText(meta, ITEM_META_MAX) : null,
    imageUrl: imageKey,
  };
}
