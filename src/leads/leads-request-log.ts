/**
 * Recognises the leads routes so the request log, metrics, Sentry and
 * feature-usage reach can leave them out.
 *
 * What each surface would otherwise record:
 * - the request log and the metrics would pair a lead id with a staff id;
 * - Sentry would ship the incoming body (a lead's name, email, phone, links or
 *   note text) as `request.data` on a 500, plus the URL and the query string,
 *   which holds the search text typed into the list;
 * - the admin page URL carries a lead id, so a `Referer` naming it would leak
 *   the same pair into any later request.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/** The leads API routes, with or without the version prefix. */
const LEADS_REQUEST_PATH = /^(?:\/v\d+)?\/admin\/leads(?:\/|$)/i;

/** The frontend leads pages, as a `Referer` pathname names them. */
const LEADS_PAGE_PATH = /(?:^|\/)admin\/leads(?:\/|$)/i;

function parsePathname(url: string): string | null {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).pathname;
  } catch {
    return null;
  }
}

/** Whether the pathname of `url` is a leads API route. */
export function isLeadsRequest(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const pathname = parsePathname(url);
  return pathname !== null && LEADS_REQUEST_PATH.test(pathname);
}

/**
 * Deletes the URL, query string and body of a Sentry request on a leads
 * route. Answers whether it did.
 */
export function dropLeadsUrl(
  request: { url?: string; query_string?: unknown; data?: unknown } | undefined,
): boolean {
  if (!request || !isLeadsRequest(request.url)) return false;
  delete request.url;
  delete request.query_string;
  delete request.data;
  return true;
}

function refererNamesLeadsPage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const pathname = parsePathname(value);
  if (pathname === null) return true;
  return LEADS_PAGE_PATH.test(pathname) || isLeadsRequest(pathname);
}

/**
 * Deletes a `Referer` header, in any key casing, that names a leads page or
 * route or that fails to parse. Answers whether it deleted one.
 */
export function dropLeadsReferer(
  request: { headers?: Record<string, unknown> } | undefined,
): boolean {
  const headers = request?.headers;
  if (!headers) return false;
  let hasDropped = false;
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== 'referer') continue;
    const headerValue = headers[headerName];
    const candidates = Array.isArray(headerValue) ? headerValue : [headerValue];
    if (candidates.some(refererNamesLeadsPage)) {
      delete headers[headerName];
      hasDropped = true;
    }
  }
  return hasDropped;
}

/** What a logged leads URL shows where the lead id or entry id was. */
export const REDACTED_LEADS_PATH = '[lead]';
/** What a logged leads URL shows where its query string was. */
export const REDACTED_LEADS_QUERY = '[query]';

const LEADS_PATH_PATTERN = /((?:^|\/)admin\/leads)(?=\/|$)(\/.*)?$/i;

/**
 * The completion line of a leads request is skipped (see `isLeadsRequest`),
 * yet every other line logged inside that request (an error from
 * `AllExceptionsFilter`, say) still carries the serialized `req.url`, which
 * names a lead id, an entry id or the search text. The request serializer
 * keeps the route base for debugging, swaps whatever follows it for `[lead]`,
 * and swaps the query string for `[query]`. Every other URL comes back
 * unchanged.
 */
export function redactLeadsPath(url: string): string;
export function redactLeadsPath(url: string | undefined): string | undefined;
export function redactLeadsPath(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return url;
  const queryStartIndex = url.search(/[?#]/);
  const path = queryStartIndex === -1 ? url : url.slice(0, queryStartIndex);
  const match = LEADS_PATH_PATTERN.exec(path);
  if (!match) return url;
  const routeBase = path.slice(0, match.index) + match[1];
  const hasTail = (match[2] ?? '').replace(/^\/+/, '').length > 0;
  const hasQuery = queryStartIndex !== -1;
  return (
    routeBase +
    (hasTail ? `/${REDACTED_LEADS_PATH}` : '') +
    (hasQuery ? `?${REDACTED_LEADS_QUERY}` : '')
  );
}
