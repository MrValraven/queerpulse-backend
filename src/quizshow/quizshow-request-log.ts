/**
 * Keeps Pulse Live request bodies (join codes, quiz text, answers) out of
 * error reports.
 *
 * Sentry 9's `httpIntegration` attaches the incoming request body to every
 * captured event as `request.data`. A 500 during a join, an import or a
 * session call would ship that body to a third-party service. The body is
 * dropped for every Pulse Live route, staff template routes included, since
 * staff template bodies carry question text and staff notes. The URL names
 * the event slug, a game, session, pairing or template id and stays, except
 * the join preview path: it carries a join code, which a room shares, so
 * that one path segment reads `[code]` (decision A12). The same goes for a
 * Referer naming the frontend's join page `/play/<code>`, which every call
 * that page makes carries.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const QUIZSHOW_PATH_PATTERN =
  /^(?:\/v\d+)?\/(?:events\/[^/]+\/quizshow|quizshow|admin\/quizshow\/templates)(?:\/[^?#]*)?\/?$/i;

/**
 * The join preview path up to its code segment, absolute or a bare path, with
 * or without the `/v1` prefix. The code ends at the next `/`, `?` or `#`.
 */
const JOIN_PREVIEW_CODE_PATTERN =
  /^((?:[a-z][a-z\d+.-]*:\/\/[^/?#]*)?(?:\/v\d+)?\/quizshow\/join-preview\/)[^/?#]+/i;

/**
 * The frontend's `/play/<segment>` page path up to that segment, absolute or
 * a bare path. The segment is a join code unless it names one of the fixed
 * Pulse Live pages under `/play` (the games list, the TV and the remote), so
 * every other segment counts as a code, a typed one with hyphens included.
 */
const PLAY_PAGE_CODE_PATTERN =
  /^((?:[a-z][a-z\d+.-]*:\/\/[^/?#]*)?\/play\/)(?!(?:games|tv|remote)(?:[/?#]|$))[^/?#]+/i;

/** What the join code segment reads in a redacted URL. */
const REDACTED_JOIN_CODE = '[code]';

/**
 * Answers whether a request URL (absolute, or a path with an optional query
 * string) is a Pulse Live route, with or without the `/v1` prefix. An absent
 * or unparseable URL answers false.
 */
export function isQuizshowRequestUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const { pathname } = new URL(url, 'http://placeholder.invalid');
    return QUIZSHOW_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Rewrites `/quizshow/join-preview/<code>` to `/quizshow/join-preview/[code]`,
 * keeping the host, the prefix and the query string. Every other URL comes
 * back unchanged, and so does an absent one.
 */
export function redactQuizshowJoinCodePath(url: string): string;
export function redactQuizshowJoinCodePath(
  url: string | undefined,
): string | undefined;
export function redactQuizshowJoinCodePath(
  url: string | undefined,
): string | undefined {
  if (typeof url !== 'string') {
    return url;
  }
  return url.replace(JOIN_PREVIEW_CODE_PATTERN, `$1${REDACTED_JOIN_CODE}`);
}

/**
 * Redacts a join code in a Referer: the frontend join page `/play/<code>`
 * (with anything after it) and the API join preview path both read
 * `[code]` in that segment. The host, the rest of the path and the query
 * string stay. Every other URL comes back unchanged.
 */
export function redactQuizshowJoinCodeReferer(url: string): string {
  return redactQuizshowJoinCodePath(url).replace(
    PLAY_PAGE_CODE_PATTERN,
    `$1${REDACTED_JOIN_CODE}`,
  );
}

/**
 * Removes the attached body from a Sentry request when it targets a Pulse
 * Live route, and redacts the join code of a join preview URL. Every other
 * request keeps its body and its URL.
 */
export function dropQuizshowRequestBody(
  request: { url?: string; data?: unknown } | undefined,
): void {
  if (request && isQuizshowRequestUrl(request.url)) {
    delete request.data;
    request.url = redactQuizshowJoinCodePath(request.url);
  }
}
