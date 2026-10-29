/**
 * Recognises the two public Studio page routes (`GET /studio/landing` and
 * `GET /studio/landing/previews/<id>/stream`) so the request log, the HTTP
 * metrics and Sentry can leave them out.
 *
 * Both routes serve strangers. A log line would pair a visit, or a preview
 * play, with an IP and a user agent, which the Studio page promises never to
 * store.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

const STUDIO_LANDING_PUBLIC_PATH =
  /^(?:\/v\d+)?\/studio\/landing(?:\/previews\/[^/]+\/stream)?\/?$/i;

/** The methods the two public routes answer, plus the CORS preflight. */
const STUDIO_LANDING_PUBLIC_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pino and the metrics middleware hand over a path with its query string,
 * Sentry hands over an absolute URL. Both reduce to the pathname first.
 */
function parsePathname(url: string): string | null {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).pathname;
  } catch {
    return null;
  }
}

export function isStudioLandingPublicRequest(
  url: string | undefined,
  method: string | undefined,
): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  // The browser sends a CORS preflight OPTIONS before a cross-origin read;
  // logging it would pair the visit with an IP just the same.
  const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
  if (!STUDIO_LANDING_PUBLIC_METHODS.has(upperMethod)) return false;
  const pathname = parsePathname(url);
  return pathname !== null && STUDIO_LANDING_PUBLIC_PATH.test(pathname);
}

/**
 * Removes the URL, query string, body, headers and cookies from a Sentry
 * request on the two public Studio page routes. Returns whether it did, so
 * the caller can skip its own URL redaction. The caller still sends the event
 * itself.
 *
 * Headers go whole: Sentry's IP scrub matches capitalized header names and
 * Node lowercases every header, so `x-forwarded-for`, `user-agent` and
 * `referer` would otherwise pair the visit with an IP and a browser.
 */
export function dropStudioLandingPublicRequest(
  request:
    | {
        url?: string;
        method?: string;
        query_string?: unknown;
        data?: unknown;
        headers?: unknown;
        cookies?: unknown;
      }
    | undefined,
): boolean {
  if (!request || !isStudioLandingPublicRequest(request.url, request.method)) {
    return false;
  }
  delete request.url;
  delete request.query_string;
  delete request.data;
  delete request.headers;
  delete request.cookies;
  return true;
}
