/**
 * Recognises the VJ routes so the request log, metrics, Sentry and
 * feature-usage reach can leave them out.
 *
 * What each surface would otherwise record:
 * - the request log and the metrics would pair a pack id and clip ids with an
 *   admin id;
 * - Sentry would ship the incoming body (a clip title or a pack name) as
 *   `request.data` on a 500, plus the URL and the query string, which holds
 *   the clip ids of a preload request;
 * - the admin screen and remote page paths sit under `admin/vj`, so a
 *   `Referer` naming one would leak the same pairing into any later request.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/** The VJ API routes, with or without the version prefix. */
const VJ_REQUEST_PATH = /^(?:\/v\d+)?\/admin\/vj(?:\/|$)/i;

/** The frontend VJ pages, as a `Referer` pathname names them. */
const VJ_PAGE_PATH = /(?:^|\/)admin\/vj(?:\/|$)/i;

function parsePathname(url: string): string | null {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).pathname;
  } catch {
    return null;
  }
}

/** Whether the pathname of `url` is a VJ API route. */
export function isVjRequest(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const pathname = parsePathname(url);
  return pathname !== null && VJ_REQUEST_PATH.test(pathname);
}

/**
 * Deletes the URL, query string and body of a Sentry request on a VJ route.
 * Answers whether it did.
 */
export function dropVjUrl(
  request: { url?: string; query_string?: unknown; data?: unknown } | undefined,
): boolean {
  if (!request || !isVjRequest(request.url)) return false;
  delete request.url;
  delete request.query_string;
  delete request.data;
  return true;
}

function refererNamesVjPage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const pathname = parsePathname(value);
  if (pathname === null) return true;
  return VJ_PAGE_PATH.test(pathname) || isVjRequest(pathname);
}

/**
 * Deletes a `Referer` header, in any key casing, that names a VJ page or route
 * or that fails to parse. Answers whether it deleted one.
 */
export function dropVjReferer(
  request: { headers?: Record<string, unknown> } | undefined,
): boolean {
  const headers = request?.headers;
  if (!headers) return false;
  let hasDropped = false;
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== 'referer') continue;
    const headerValue = headers[headerName];
    const candidates = Array.isArray(headerValue) ? headerValue : [headerValue];
    if (candidates.some(refererNamesVjPage)) {
      delete headers[headerName];
      hasDropped = true;
    }
  }
  return hasDropped;
}

/** What a logged VJ URL shows where the pack id, clip id or sub-route was. */
export const REDACTED_VJ_PATH = '[vj]';
/** What a logged VJ URL shows where its query string was. */
export const REDACTED_VJ_QUERY = '[query]';

const VJ_PATH_PATTERN = /((?:^|\/)admin\/vj)(?=\/|$)(\/.*)?$/i;

/**
 * The completion line of a VJ request is skipped (see `isVjRequest`), yet
 * every other line logged inside that request (an error from
 * `AllExceptionsFilter`, say) still carries the serialized `req.url`, which
 * names a pack id or clip ids. The request serializer keeps the route base for
 * debugging, swaps whatever follows it for `[vj]`, and swaps the query string
 * for `[query]`. Every other URL comes back unchanged.
 */
export function redactVjPath(url: string): string;
export function redactVjPath(url: string | undefined): string | undefined;
export function redactVjPath(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return url;
  const queryStartIndex = url.search(/[?#]/);
  const path = queryStartIndex === -1 ? url : url.slice(0, queryStartIndex);
  const match = VJ_PATH_PATTERN.exec(path);
  if (!match) return url;
  const routeBase = path.slice(0, match.index) + match[1];
  const hasTail = (match[2] ?? '').replace(/^\/+/, '').length > 0;
  const hasQuery = queryStartIndex !== -1;
  return (
    routeBase +
    (hasTail ? `/${REDACTED_VJ_PATH}` : '') +
    (hasQuery ? `?${REDACTED_VJ_QUERY}` : '')
  );
}
