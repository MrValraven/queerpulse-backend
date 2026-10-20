/**
 * Recognises the creator draft routes so the request log, metrics, Sentry and
 * feature-usage reach can leave them out.
 *
 * What each surface would otherwise record:
 * - the request log and the metrics would pair a draft id with an admin id;
 * - Sentry would ship the incoming body (the whole draft payload) as
 *   `request.data` on a 500, plus the URL and query string;
 * - the admin page URL carries the draft kind and id, so a `Referer` naming it
 *   would leak the same pair into any later request.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

const DRAFT_REQUEST_PATH =
  /^(?:\/v\d+)?\/(?:me\/creator-drafts|admin\/creator-drafts|admin\/listing-drafts)(?:\/|$)/i;

const ADMIN_DRAFT_PAGE_PATH = /(?:^|\/)admin\/creator-drafts(?:\/|$)/i;

function parsePathname(url: string): string | null {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).pathname;
  } catch {
    return null;
  }
}

export function isCreatorDraftRequest(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const pathname = parsePathname(url);
  return pathname !== null && DRAFT_REQUEST_PATH.test(pathname);
}

export function dropCreatorDraftUrl(
  request: { url?: string; query_string?: unknown; data?: unknown } | undefined,
): boolean {
  if (!request || !isCreatorDraftRequest(request.url)) return false;
  delete request.url;
  delete request.query_string;
  delete request.data;
  return true;
}

function refererNamesDraftPage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const pathname = parsePathname(value);
  if (pathname === null) return true;
  return (
    ADMIN_DRAFT_PAGE_PATH.test(pathname) || isCreatorDraftRequest(pathname)
  );
}

export function dropCreatorDraftReferer(
  request: { headers?: Record<string, unknown> } | undefined,
): boolean {
  const headers = request?.headers;
  if (!headers) return false;
  let hasDropped = false;
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== 'referer') continue;
    const headerValue = headers[headerName];
    const candidates = Array.isArray(headerValue) ? headerValue : [headerValue];
    if (candidates.some(refererNamesDraftPage)) {
      delete headers[headerName];
      hasDropped = true;
    }
  }
  return hasDropped;
}

/** What a logged creator draft URL shows where the kind, id or ref was. */
export const REDACTED_CREATOR_DRAFT_PATH = '[draft]';
/** What a logged creator draft URL shows where its query string was. */
export const REDACTED_CREATOR_DRAFT_QUERY = '[query]';

const CREATOR_DRAFT_PATH_PATTERN =
  /((?:^|\/)(?:me|admin)\/creator-drafts)(?=\/|$)(\/.*)?$/i;

/**
 * The completion line of a creator draft request is skipped (see
 * `isCreatorDraftRequest`), yet every other line logged inside that request
 * (an error from `AllExceptionsFilter`, say) still carries the serialized
 * `req.url`, which names the draft kind, a draft id or a listing ref. The
 * request serializer keeps the route base for debugging, swaps whatever
 * follows it for `[draft]`, and swaps the query string (the admin list's kind
 * filter) for `[query]`. Every other URL comes back unchanged.
 */
export function redactCreatorDraftPath(url: string): string;
export function redactCreatorDraftPath(
  url: string | undefined,
): string | undefined;
export function redactCreatorDraftPath(
  url: string | undefined,
): string | undefined {
  if (typeof url !== 'string') return url;
  const queryStartIndex = url.search(/[?#]/);
  const path = queryStartIndex === -1 ? url : url.slice(0, queryStartIndex);
  const match = CREATOR_DRAFT_PATH_PATTERN.exec(path);
  if (!match) return url;
  const routeBase = path.slice(0, match.index) + match[1];
  const hasTail = (match[2] ?? '').replace(/^\/+/, '').length > 0;
  const hasQuery = queryStartIndex !== -1;
  return (
    routeBase +
    (hasTail ? `/${REDACTED_CREATOR_DRAFT_PATH}` : '') +
    (hasQuery ? `?${REDACTED_CREATOR_DRAFT_QUERY}` : '')
  );
}
