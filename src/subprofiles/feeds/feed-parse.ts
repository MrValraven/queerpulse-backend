import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';

/**
 * Podcast RSS parsing for persona feed import. Pure: no I/O, so every rule
 * below is unit-tested against fixture feeds in `feed-parse.spec.ts`.
 *
 * Scope is RSS 2.0 plus the iTunes namespace, the format every podcast host
 * publishes. Atom, RSS 1.0 (RDF) and HTML come back as `not_a_feed`.
 */

/** Newest episodes kept from one feed. */
export const MAX_FEED_EPISODES = 500;
/** Plain-text cap for an episode or show description. */
export const MAX_DESCRIPTION_LENGTH = 2000;
/** Longest episode title kept (the item title cap applies again on publish). */
export const MAX_EPISODE_TITLE_LENGTH = 500;
const MAX_SHOW_TITLE_LENGTH = 300;
const MAX_AUTHOR_LENGTH = 200;
/** Longest guid stored as-is; a longer one is stored as its SHA-1. */
export const MAX_GUID_LENGTH = 500;
/** Longest URL kept (links, enclosure URLs, art URLs). */
export const MAX_FEED_URL_LENGTH = 2048;
/** A duration past a week is a malformed value, not an episode. */
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_SEASON_OR_EPISODE = 1_000_000;

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string | null;
  link: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  season: number | null;
  episode: number | null;
  /** Remote episode art. Server-side only: never returned to a client. */
  imageUrl: string | null;
}

export interface ParsedFeed {
  title: string | null;
  author: string | null;
  description: string | null;
  /** Remote show art. Server-side only: never returned to a client. */
  imageUrl: string | null;
  /** Every usable episode the feed lists (before the 500 cap). */
  episodeCount: number;
  /** Newest first, at most {@link MAX_FEED_EPISODES}. */
  episodes: ParsedEpisode[];
}

/** The document could be fetched but is not an RSS 2.0 feed. */
export class NotAFeedError extends Error {
  constructor(reason: string) {
    super(`not_a_feed: ${reason}`);
    this.name = 'NotAFeedError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string: `parseTagValue` would turn a numeric guid or
  // `<itunes:episode>007</itunes:episode>` into a lossy number.
  parseTagValue: false,
  parseAttributeValue: false,
  // Untrimmed, so `Episode 2: <![CDATA[Pride]]>` keeps the space between its
  // text and CDATA parts; `toPlainText` collapses and trims afterwards.
  trimValues: false,
  // Predefined XML entities and numeric references. `<!ENTITY` declarations
  // never get this far (see `parsePodcastFeed`).
  processEntities: true,
  htmlEntities: true,
});

/**
 * Parse an RSS 2.0 podcast feed. Throws {@link NotAFeedError} for anything
 * that is not one: malformed XML, an entity declaration, Atom, RDF, HTML, or
 * an `<rss>` with no `<channel>`.
 */
export function parsePodcastFeed(xml: string): ParsedFeed {
  // Entity-expansion defence ("billion laughs" and external entities): a
  // podcast feed has no business declaring entities, so refuse the document
  // outright rather than trust the parser's expansion limits.
  if (/<!ENTITY/i.test(xml)) {
    throw new NotAFeedError('entity declaration');
  }
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    throw new NotAFeedError('malformed xml');
  }
  const rss = asRecord(first(asRecord(document)?.['rss']));
  const channel = asRecord(first(rss?.['channel']));
  if (!channel) {
    throw new NotAFeedError('no rss channel');
  }

  const rawItems = toArray(channel['item']);
  const seenGuids = new Set<string>();
  const episodes: ParsedEpisode[] = [];
  for (const rawItem of rawItems) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const episode = parseItem(item);
    if (!episode || seenGuids.has(episode.guid)) continue;
    seenGuids.add(episode.guid);
    episodes.push(episode);
  }
  // Newest first. Undated episodes sort after dated ones and otherwise keep
  // document order (Array.prototype.sort is stable).
  episodes.sort(
    (left, right) =>
      (right.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
      (left.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY),
  );

  return {
    title: plainTextOrNull(textOf(channel['title']), MAX_SHOW_TITLE_LENGTH),
    author: plainTextOrNull(
      textOf(channel['itunes:author']) ??
        textOf(asRecord(first(channel['itunes:owner']))?.['itunes:name']),
      MAX_AUTHOR_LENGTH,
    ),
    description: plainTextOrNull(
      textOf(channel['description']) ?? textOf(channel['itunes:summary']),
      MAX_DESCRIPTION_LENGTH,
    ),
    imageUrl:
      httpUrlOrNull(attributeOf(channel['itunes:image'], 'href')) ??
      httpUrlOrNull(textOf(asRecord(first(channel['image']))?.['url'])),
    episodeCount: episodes.length,
    episodes: episodes.slice(0, MAX_FEED_EPISODES),
  };
}

function parseItem(item: Record<string, unknown>): ParsedEpisode | null {
  const title = plainTextOrNull(
    textOf(item['title']) ?? textOf(item['itunes:title']),
    MAX_EPISODE_TITLE_LENGTH,
  );
  if (!title) return null;

  const enclosureUrl = httpUrlOrNull(attributeOf(item['enclosure'], 'url'));
  const pageLink = httpUrlOrNull(textOf(item['link']));
  const rawPubDate = textOf(item['pubDate']) ?? textOf(item['dc:date']);

  return {
    guid: episodeGuid(
      textOf(item['guid']),
      enclosureUrl,
      pageLink,
      title,
      rawPubDate,
    ),
    title,
    description: plainTextOrNull(
      textOf(item['description']) ??
        textOf(item['itunes:summary']) ??
        textOf(item['content:encoded']),
      MAX_DESCRIPTION_LENGTH,
    ),
    link: pageLink ?? enclosureUrl,
    publishedAt: parsePubDate(rawPubDate),
    durationSeconds: parseDuration(textOf(item['itunes:duration'])),
    season: parseEpisodeNumber(textOf(item['itunes:season'])),
    episode: parseEpisodeNumber(textOf(item['itunes:episode'])),
    imageUrl: httpUrlOrNull(attributeOf(item['itunes:image'], 'href')),
  };
}

/**
 * The key an episode is remembered by: its `<guid>`, else its enclosure URL,
 * else its page link, else a hash of title + pubDate. A value too long for
 * the column is stored as its SHA-1 so it stays stable across syncs.
 */
export function episodeGuid(
  guid: string | null,
  enclosureUrl: string | null,
  link: string | null,
  title: string,
  rawPubDate: string | null,
): string {
  const candidate = guid?.trim() || enclosureUrl || link;
  if (candidate) {
    return candidate.length <= MAX_GUID_LENGTH
      ? candidate
      : `sha1:${sha1(candidate)}`;
  }
  return `sha1:${sha1(`${title}\n${rawPubDate ?? ''}`)}`;
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

/**
 * `<itunes:duration>` to whole seconds: plain seconds (`"3600"`, `"3600.5"`),
 * `mm:ss` or `hh:mm:ss`. Anything else, zero, or over a week is null.
 */
export function parseDuration(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(value)) {
    seconds = Math.floor(Number(value));
  } else if (/^\d{1,4}(:\d{1,2}){1,2}(\.\d+)?$/.test(value)) {
    const parts = value.split(':').map((part) => Number(part));
    if (parts.slice(1).some((part) => part >= 60)) return null;
    seconds = Math.floor(parts.reduce((total, part) => total * 60 + part, 0));
  } else {
    return null;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds > MAX_DURATION_SECONDS ? null : seconds;
}

/**
 * An RFC 822 `<pubDate>` (or an ISO `dc:date`) to a Date, or null. Accepts
 * the common real-world deviations: a missing weekday, a named US zone, a
 * single-digit day.
 */
export function parsePubDate(raw: string | null): Date | null {
  if (!raw) return null;
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return null;
  let timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    // Drop a weekday a feed misspelled ("Tues,") and retry.
    timestamp = Date.parse(value.replace(/^[A-Za-z]+,?\s*/, ''));
  }
  if (Number.isNaN(timestamp)) {
    // An unknown zone abbreviation ("CEST"): read the wall time as UTC rather
    // than lose the date entirely.
    timestamp = Date.parse(`${value.replace(/\s+[A-Za-z]{2,5}$/, '')} GMT`);
  }
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

/** `<itunes:season>` / `<itunes:episode>`: a non-negative integer or null. */
export function parseEpisodeNumber(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= MAX_SEASON_OR_EPISODE ? parsed : null;
}

// Block-level closers become whitespace BEFORE the tags are stripped, so
// `<p>One</p><p>Two</p>` reads "One Two" rather than "OneTwo".
const BLOCK_BOUNDARY =
  /<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/tr|hr)\b[^>]*>/gi;

const PLAIN_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  // Drop the tag, keep its text; `script`/`style` content is dropped whole.
  disallowedTagsMode: 'discard',
};

// sanitize-html re-encodes the text it emits. `&amp;` is decoded LAST so
// `&amp;lt;` cannot be folded into a `<` that was never there.
const ENTITY_DECODINGS: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

/**
 * Feed text (possibly HTML, possibly entity-encoded HTML inside CDATA) to
 * plain text: tags stripped, entities decoded, whitespace collapsed to single
 * spaces, trimmed. Runs to a bounded fixed point because decoding can reveal
 * markup that was entity-encoded (`&lt;b&gt;`), which a second pass removes.
 */
export function toPlainText(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    let stripped = sanitizeHtml(
      current.replace(BLOCK_BOUNDARY, ' '),
      PLAIN_TEXT_OPTIONS,
    );
    for (const [pattern, character] of ENTITY_DECODINGS) {
      stripped = stripped.replace(pattern, character);
    }
    if (stripped === current) break;
    current = stripped;
  }
  return current.replace(/\s+/g, ' ').trim();
}

/** Cut `value` to at most `maxLength` characters, ending in an ellipsis when
 *  cut. Counts UTF-16 units, the way the column/DTO `MaxLength` does. */
export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function plainTextOrNull(
  value: string | null,
  maxLength: number,
): string | null {
  if (value === null) return null;
  const text = toPlainText(value);
  return text ? truncateText(text, maxLength) : null;
}

/** An absolute http(s) URL that fits the column, else null. */
function httpUrlOrNull(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FEED_URL_LENGTH) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

// --- untyped parser-output helpers -------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? (value as unknown[])[0] : value;
}

/** The text content of an element: a bare string, or `#text` when the element
 *  also carries attributes. Empty text is null. */
function textOf(value: unknown): string | null {
  const node = first(value);
  if (typeof node === 'string') return node.trim() ? node : null;
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  const text = asRecord(node)?.['#text'];
  if (typeof text === 'string') return text.trim() ? text : null;
  if (typeof text === 'number') return String(text);
  return null;
}

function attributeOf(value: unknown, name: string): string | null {
  const attribute = asRecord(first(value))?.[`@_${name}`];
  return typeof attribute === 'string' && attribute.trim() ? attribute : null;
}
