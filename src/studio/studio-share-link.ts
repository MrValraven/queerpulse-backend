import { MAX_QUERY_VALUE_DECODE_PASSES } from '../common/redact-url';
import { resolveAllowedOrigins } from '../config/frontend-origins';

/**
 * Studio rich cards: the backend reader of a Studio share link. The grammar
 * lives in QUEERPULSE-STUDIO-RICH-CARDS-CONTRACT-2026-10-14.md, and the
 * frontend mirror is `queerpulse/src/features/studio/share/studioLinkTarget.ts`.
 *
 * A Studio link is an absolute URL on one of this deployment's frontend
 * origins, or a root-relative path, whose path is `/studio/track`,
 * `/studio/album` or `/studio/collection` and whose `id` is a uuid. A
 * milestone link is `/studio/artist` with an `id` uuid and a `milestone` uuid.
 * Preview links (`/studio/preview/<token>`) are bearer secrets and never
 * parse; artist pages stay plain links unless they carry a `milestone` uuid,
 * and scenes and shelves stay plain links. This module reads no
 * database, logs nothing and imports only the origin parser and the decode
 * depth `common/redact-url.ts` uses.
 */

export type StudioShareKind = 'track' | 'release' | 'playlist' | 'milestone';

export interface StudioShareLink {
  kind: StudioShareKind;
  /** The uuid from `id`, lower-cased. A milestone link holds the milestone uuid here. */
  id: string;
  /** Milestone links only: the persona uuid from `id`, lower-cased; `id` holds the milestone. */
  artistId?: string;
  /** Track links only: the `t` timestamp in whole seconds, else null. */
  startAtSeconds: number | null;
  /**
   * Lyric links (PRD-13): a track link with `line`, the index of one timed
   * lyric line, 0 to 499. Set only when the link carries a usable one; the
   * frontend reads such a link as its `lyric` kind. The URL holds the index
   * only, never the words.
   */
  lineIndex?: number;
  /** The canonical root-relative form, `/studio/track?id=<id>` plus `&t=<s>` when set, then `&line=<n>` when set. */
  path: string;
}

/** A Studio link found in free text: the link, the exact substring and where it starts. */
export interface StudioShareLinkMatch {
  link: StudioShareLink;
  url: string;
  index: number;
}

/** The largest `t` a track link carries: one day, in seconds. */
export const STUDIO_SHARE_MAX_START_SECONDS = 86_400;

const KIND_BY_PATH = new Map<string, StudioShareKind>([
  ['/studio/track', 'track'],
  ['/studio/album', 'release'],
  ['/studio/collection', 'playlist'],
]);

const PATH_BY_KIND: Readonly<Record<StudioShareKind, string>> = {
  track: '/studio/track',
  release: '/studio/album',
  playlist: '/studio/collection',
  milestone: '/studio/artist',
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WHOLE_SECONDS_PATTERN = /^\d{1,5}$/;

/** The largest `line` a lyric link carries: a track holds 500 timed lines. */
export const STUDIO_SHARE_MAX_LINE_INDEX = 499;

const LINE_INDEX_PATTERN = /^\d{1,3}$/;

const RELATIVE_PATH_PREFIX = '/studio/';

/** Resolves a root-relative path. The placeholder host is never read. */
const RELATIVE_PATH_BASE = 'http://studio-share.invalid';

/**
 * A URL candidate in free text: a run of non-whitespace that starts with
 * `http://`, `https://` or `/studio/`, at the start of the text or after
 * whitespace or an opening bracket or quote (`«` included for European
 * Portuguese). The boundary keeps `example.com/studio/track?id=...` (another
 * host typed without a scheme) from reading as a root-relative path.
 */
const URL_CANDIDATE_PATTERN =
  /(?<=^|[\s([{<«'"])(?:https?:\/\/|\/studio\/)\S*/gi;

/** Trimmed off the end of a URL candidate, and the characters that take no space before them in a note. */
const CLOSING_PUNCTUATION = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '>',
  '»',
  "'",
  '"',
]);

/** Each opener a link may sit inside, with the closer that ends the pair. */
const CLOSER_BY_OPENER = new Map<string, string>([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['«', '»'],
  ["'", "'"],
  ['"', '"'],
]);

const LINE_SPACE = new Set([' ', '\t']);

const LINE_BREAK = new Set(['\n']);

/** A note with nothing left to read: brackets, punctuation and spaces only. */
const LEFTOVER_ONLY_PATTERN = /^[\s.,;:!?()[\]{}<>«»'"]*$/;

const STUDIO_PATH_PATTERN = /^\/studio(?:\/|$)/i;

/**
 * How many times an own-origin path is percent-decoded while it keeps
 * changing: the depth the log redaction reads a query value to.
 */
const MAX_DECODE_PASSES = MAX_QUERY_VALUE_DECODE_PASSES;

/**
 * The production frontend origins, which the frontend link reader always
 * accepts (`studioLinkTarget.ts`), so a `www` link reads as a Studio link
 * on both sides whatever `FRONTEND_URL` lists.
 */
const CANONICAL_FRONTEND_ORIGINS: readonly string[] = [
  'https://queerpulse.com',
  'https://www.queerpulse.com',
];

/**
 * The origins a Studio link may sit on: the `FRONTEND_URL` allowlist (plus
 * the Vite dev origin outside production, the same union CORS and the socket
 * handshake use), joined with the two production origins the frontend always
 * accepts. Read at call time, so a test can set `FRONTEND_URL` per case.
 */
export function studioShareOrigins(): string[] {
  return Array.from(
    new Set([...resolveAllowedOrigins(), ...CANONICAL_FRONTEND_ORIGINS]),
  );
}

/** One URL to a Studio link, or null when it is anything else. */
export function parseStudioShareLink(
  url: string,
  origins: readonly string[],
): StudioShareLink | null {
  return parseWithOriginSet(url, toOriginSet(origins));
}

/**
 * The first Studio link in free text, with the exact substring (trailing
 * punctuation trimmed) and its start index. A candidate that does not parse
 * is skipped, so the first link that does parse wins.
 */
export function findStudioShareLinkMatch(
  text: string,
  origins: readonly string[],
): StudioShareLinkMatch | null {
  const originSet = toOriginSet(origins);
  for (const candidate of text.matchAll(URL_CANDIDATE_PATTERN)) {
    const url = trimEndWhile(candidate[0], CLOSING_PUNCTUATION);
    const link = parseWithOriginSet(url, originSet);
    if (link) {
      return { link, url, index: candidate.index };
    }
  }
  return null;
}

export function findStudioShareLink(
  text: string,
  origins: readonly string[],
): StudioShareLink | null {
  return findStudioShareLinkMatch(text, origins)?.link ?? null;
}

/**
 * The text with the matched link taken out. CRLF reads as LF. When the link
 * sits inside a bracket or quote pair, that pair goes too. The two sides are
 * joined by one space (none before closing punctuation or across a line
 * break), the blank line a link on its own line leaves is dropped, and the
 * result is trimmed. Answers '' when only brackets, punctuation and spaces
 * are left.
 */
export function textWithoutStudioShareLink(
  text: string,
  match: StudioShareLinkMatch,
): string {
  let before = trimEndWhile(
    toLineFeeds(text.slice(0, match.index)),
    LINE_SPACE,
  );
  let after = trimStartWhile(
    toLineFeeds(text.slice(match.index + match.url.length)),
    LINE_SPACE,
  );
  const closer = CLOSER_BY_OPENER.get(before.slice(-1));
  if (closer !== undefined && after.startsWith(closer)) {
    before = trimEndWhile(before.slice(0, -1), LINE_SPACE);
    after = trimStartWhile(after.slice(closer.length), LINE_SPACE);
  }
  const note = joinNoteSides(before, after).trim();
  return LEFTOVER_ONLY_PATTERN.test(note) ? '' : note;
}

/**
 * The text with its first Studio link taken out (post-surface reading), for a
 * notification or activity excerpt that is cut afterwards, so a raw Studio
 * URL never reaches an excerpt. Text with no Studio link comes back as is.
 */
export function textWithoutFirstStudioShareLink(
  text: string,
  origins: readonly string[],
): string {
  const match = findStudioShareLinkMatch(text, origins);
  return match ? postTextWithoutStudioShareLink(text, match) : text;
}

/**
 * The post-surface reading of {@link textWithoutStudioShareLink}: when the
 * matched link is the target of a markdown link `[label](url)` (a label on
 * one line, holding no bracket), the whole markdown link reads as its label,
 * so `listen to [the EP](url) tonight` reads `listen to the EP tonight`. An
 * empty label takes the link out with the same join rules. Every other match
 * reads as `textWithoutStudioShareLink` reads it. CRLF reads as LF, the
 * result is trimmed, and it answers '' when only brackets, punctuation and
 * spaces are left.
 */
export function postTextWithoutStudioShareLink(
  text: string,
  match: StudioShareLinkMatch,
): string {
  const markdownLink = markdownLinkAround(text, match);
  if (!markdownLink) {
    return textWithoutStudioShareLink(text, match);
  }
  if (markdownLink.label === '') {
    return textWithoutStudioShareLink(text, {
      link: match.link,
      url: text.slice(markdownLink.startIndex, markdownLink.endIndex),
      index: markdownLink.startIndex,
    });
  }
  const note = toLineFeeds(
    `${text.slice(0, markdownLink.startIndex)}${markdownLink.label}${text.slice(markdownLink.endIndex)}`,
  ).trim();
  return LEFTOVER_ONLY_PATTERN.test(note) ? '' : note;
}

/** Where a markdown link `[label](url)` around the match starts and ends, with its label. */
function markdownLinkAround(
  text: string,
  match: StudioShareLinkMatch,
): { label: string; startIndex: number; endIndex: number } | null {
  const before = text.slice(0, match.index);
  const urlEndIndex = match.index + match.url.length;
  if (!before.endsWith('](') || text.charAt(urlEndIndex) !== ')') {
    return null;
  }
  const labelEndIndex = before.length - 2;
  const openerIndex = before.lastIndexOf('[', labelEndIndex - 1);
  if (openerIndex === -1) {
    return null;
  }
  const label = before.slice(openerIndex + 1, labelEndIndex);
  if (/[[\]\n\r]/.test(label)) {
    return null;
  }
  return { label, startIndex: openerIndex, endIndex: urlEndIndex + 1 };
}

/**
 * True for any `/studio` path (previews, artist pages and the Studio home
 * included) on one of `origins`. Case-blind, and it also reads the path
 * percent-decoded (up to five passes, while each pass changes it) and with
 * repeated slashes collapsed, so an odd spelling of the same page answers
 * the same. Userinfo on the host still answers true, so the caller refuses it.
 */
export function isOwnOriginStudioUrl(
  url: string,
  origins: readonly string[],
): boolean {
  const parsed = parsedUrlOrNull(url.trim());
  if (!parsed || !toOriginSet(origins).has(parsed.origin)) {
    return false;
  }
  let path = parsed.pathname;
  for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
    if (STUDIO_PATH_PATTERN.test(path.replace(/\/{2,}/g, '/'))) {
      return true;
    }
    const decodedPath = decodedOrSelf(path);
    if (decodedPath === path) {
      return false;
    }
    path = decodedPath;
  }
  return false;
}

function parseWithOriginSet(
  url: string,
  originSet: ReadonlySet<string>,
): StudioShareLink | null {
  const parsed = parsedOnOwnOrigin(url.trim(), originSet);
  if (!parsed) {
    return null;
  }
  if (parsed.pathname === PATH_BY_KIND.milestone) {
    return parseMilestoneLink(parsed.searchParams);
  }
  const kind = KIND_BY_PATH.get(parsed.pathname);
  if (!kind) {
    return null;
  }
  const rawId = parsed.searchParams.get('id') ?? '';
  if (!UUID_PATTERN.test(rawId)) {
    return null;
  }
  const id = rawId.toLowerCase();
  const startAtSeconds =
    kind === 'track' ? parseStartAtSeconds(parsed.searchParams.get('t')) : null;
  const basePath = `${PATH_BY_KIND[kind]}?id=${id}`;
  const timedPath =
    startAtSeconds === null ? basePath : `${basePath}&t=${startAtSeconds}`;
  const lineIndex =
    kind === 'track' ? parseLineIndex(parsed.searchParams.get('line')) : null;
  if (lineIndex === null) {
    return { kind, id, startAtSeconds, path: timedPath };
  }
  return {
    kind,
    id,
    startAtSeconds,
    lineIndex,
    path: `${timedPath}&line=${lineIndex}`,
  };
}

function parseMilestoneLink(
  searchParams: URLSearchParams,
): StudioShareLink | null {
  const rawArtistId = searchParams.get('id') ?? '';
  const rawMilestoneId = searchParams.get('milestone') ?? '';
  if (!UUID_PATTERN.test(rawArtistId) || !UUID_PATTERN.test(rawMilestoneId)) {
    return null;
  }
  const artistId = rawArtistId.toLowerCase();
  const id = rawMilestoneId.toLowerCase();
  return {
    kind: 'milestone',
    id,
    artistId,
    startAtSeconds: null,
    path: `${PATH_BY_KIND.milestone}?id=${artistId}&milestone=${id}`,
  };
}

function parseLineIndex(rawValue: string | null): number | null {
  if (rawValue === null || !LINE_INDEX_PATTERN.test(rawValue)) {
    return null;
  }
  const lineIndex = Number(rawValue);
  return lineIndex <= STUDIO_SHARE_MAX_LINE_INDEX ? lineIndex : null;
}

function parsedOnOwnOrigin(
  url: string,
  originSet: ReadonlySet<string>,
): URL | null {
  if (url.startsWith(RELATIVE_PATH_PREFIX)) {
    return parsedUrlOrNull(url, RELATIVE_PATH_BASE);
  }
  const parsed = parsedUrlOrNull(url);
  const hasUserinfo =
    parsed !== null && (parsed.username !== '' || parsed.password !== '');
  return parsed && !hasUserinfo && originSet.has(parsed.origin) ? parsed : null;
}

function parseStartAtSeconds(rawValue: string | null): number | null {
  if (rawValue === null || !WHOLE_SECONDS_PATTERN.test(rawValue)) {
    return null;
  }
  const seconds = Number(rawValue);
  return seconds <= STUDIO_SHARE_MAX_START_SECONDS ? seconds : null;
}

/**
 * Joins the two sides of a removed link. When both touch a line break, the
 * link had a line to itself: the longer of the two break runs stays, so the
 * paragraph spacing around it survives once.
 */
function joinNoteSides(before: string, after: string): string {
  const trailingBreakCount =
    before.length - trimEndWhile(before, LINE_BREAK).length;
  const leadingBreakCount =
    after.length - trimStartWhile(after, LINE_BREAK).length;
  if (trailingBreakCount > 0 && leadingBreakCount > 0) {
    const breaks = '\n'.repeat(Math.max(trailingBreakCount, leadingBreakCount));
    return `${before.slice(0, before.length - trailingBreakCount)}${breaks}${after.slice(leadingBreakCount)}`;
  }
  return `${before}${shouldJoinWithSpace(before, after) ? ' ' : ''}${after}`;
}

function shouldJoinWithSpace(before: string, after: string): boolean {
  return (
    before !== '' &&
    after !== '' &&
    !before.endsWith('\n') &&
    !after.startsWith('\n') &&
    !CLOSING_PUNCTUATION.has(after.charAt(0))
  );
}

function toLineFeeds(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

/** Drops trailing characters from `characterSet` with one backward pass. */
function trimEndWhile(
  value: string,
  characterSet: ReadonlySet<string>,
): string {
  let endIndex = value.length;
  while (endIndex > 0 && characterSet.has(value.charAt(endIndex - 1))) {
    endIndex -= 1;
  }
  return value.slice(0, endIndex);
}

/** Drops leading characters from `characterSet` with one forward pass. */
function trimStartWhile(
  value: string,
  characterSet: ReadonlySet<string>,
): string {
  let startIndex = 0;
  while (
    startIndex < value.length &&
    characterSet.has(value.charAt(startIndex))
  ) {
    startIndex += 1;
  }
  return value.slice(startIndex);
}

/** Each configured origin in `URL.origin` form; one that does not parse names nothing. */
function toOriginSet(origins: readonly string[]): Set<string> {
  const originSet = new Set<string>();
  for (const origin of origins) {
    const parsed = parsedUrlOrNull(origin.trim());
    if (parsed && parsed.origin !== 'null') {
      originSet.add(parsed.origin);
    }
  }
  return originSet;
}

function parsedUrlOrNull(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

function decodedOrSelf(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
