/**
 * Recognises the Cultural Production routes so the request log, metrics,
 * Sentry and feature-usage reach can leave them out.
 *
 * What each surface would otherwise record:
 * - the request log and the metrics would pair an idea, task or guide id with
 *   a staff id;
 * - Sentry would ship the incoming body (idea text, task notes, comments and
 *   guide sections) as `request.data` on a 500, plus the URL and the query
 *   string, which holds the staff search text typed into the picker;
 * - the admin page URL carries an idea, task or guide id, so a `Referer`
 *   naming it would leak the same pair into any later request.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/** The Cultural Production API routes, with or without the version prefix. */
const CULTURAL_PRODUCTION_REQUEST_PATH =
  /^(?:\/v\d+)?\/admin\/cultural-production(?:\/|$)/i;

/** The frontend Cultural Production pages, as a `Referer` pathname names them. */
const CULTURAL_PRODUCTION_PAGE_PATH =
  /(?:^|\/)admin\/cultural-production(?:\/|$)/i;

function parsePathname(url: string): string | null {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).pathname;
  } catch {
    return null;
  }
}

/** Whether the pathname of `url` is a Cultural Production API route. */
export function isCulturalProductionRequest(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const pathname = parsePathname(url);
  return pathname !== null && CULTURAL_PRODUCTION_REQUEST_PATH.test(pathname);
}

/**
 * Deletes the URL, query string and body of a Sentry request on a Cultural
 * Production route. Answers whether it did.
 */
export function dropCulturalProductionUrl(
  request: { url?: string; query_string?: unknown; data?: unknown } | undefined,
): boolean {
  if (!request || !isCulturalProductionRequest(request.url)) return false;
  delete request.url;
  delete request.query_string;
  delete request.data;
  return true;
}

function refererNamesCulturalProductionPage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const pathname = parsePathname(value);
  if (pathname === null) return true;
  return (
    CULTURAL_PRODUCTION_PAGE_PATH.test(pathname) ||
    isCulturalProductionRequest(pathname)
  );
}

/**
 * Deletes a `Referer` header, in any key casing, that names a Cultural
 * Production page or route or that fails to parse. Answers whether it deleted
 * one.
 */
export function dropCulturalProductionReferer(
  request: { headers?: Record<string, unknown> } | undefined,
): boolean {
  const headers = request?.headers;
  if (!headers) return false;
  let hasDropped = false;
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== 'referer') continue;
    const headerValue = headers[headerName];
    const candidates = Array.isArray(headerValue) ? headerValue : [headerValue];
    if (candidates.some(refererNamesCulturalProductionPage)) {
      delete headers[headerName];
      hasDropped = true;
    }
  }
  return hasDropped;
}

/** What a logged Cultural Production URL shows where the record id or sub-path was. */
export const REDACTED_CULTURAL_PRODUCTION_PATH = '[cultural]';
/** What a logged Cultural Production URL shows where its query string was. */
export const REDACTED_CULTURAL_PRODUCTION_QUERY = '[query]';

const CULTURAL_PRODUCTION_PATH_PATTERN =
  /((?:^|\/)admin\/cultural-production)(?=\/|$)(\/.*)?$/i;

/**
 * The completion line of a Cultural Production request is skipped (see
 * `isCulturalProductionRequest`), yet every other line logged inside that
 * request (an error from `AllExceptionsFilter`, say) still carries the
 * serialized `req.url`, which names an idea, task or guide id or the staff
 * search text. The request serializer keeps the route base for debugging,
 * swaps whatever follows it for `[cultural]`, and swaps the query string for
 * `[query]`. Every other URL comes back unchanged.
 */
export function redactCulturalProductionPath(url: string): string;
export function redactCulturalProductionPath(
  url: string | undefined,
): string | undefined;
export function redactCulturalProductionPath(
  url: string | undefined,
): string | undefined {
  if (typeof url !== 'string') return url;
  const queryStartIndex = url.search(/[?#]/);
  const path = queryStartIndex === -1 ? url : url.slice(0, queryStartIndex);
  const match = CULTURAL_PRODUCTION_PATH_PATTERN.exec(path);
  if (!match) return url;
  const routeBase = path.slice(0, match.index) + match[1];
  const hasTail = (match[2] ?? '').replace(/^\/+/, '').length > 0;
  const hasQuery = queryStartIndex !== -1;
  return (
    routeBase +
    (hasTail ? `/${REDACTED_CULTURAL_PRODUCTION_PATH}` : '') +
    (hasQuery ? `?${REDACTED_CULTURAL_PRODUCTION_QUERY}` : '')
  );
}
