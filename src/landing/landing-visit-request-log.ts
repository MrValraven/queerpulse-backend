/**
 * Recognises the anonymous landing visit beacon so the request log, the HTTP
 * metrics and Sentry can leave it out.
 *
 * The beacon only bumps a (day, source) counter. A request log line would pair
 * that visit with an IP, a user agent and a timestamp, which is exactly what
 * the counter avoids storing.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

const LANDING_VISIT_BEACON_PATH = /^(?:\/v\d+)?\/landing\/visits\/?(?:\?|$)/i;

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

export function isLandingVisitBeacon(
  url: string | undefined,
  method: string | undefined,
): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  // The browser sends a CORS preflight OPTIONS before the JSON POST; logging
  // it would pair the visit with an IP just the same.
  const upperMethod = typeof method === 'string' ? method.toUpperCase() : '';
  if (upperMethod !== 'POST' && upperMethod !== 'OPTIONS') return false;
  const pathname = parsePathname(url);
  return pathname !== null && LANDING_VISIT_BEACON_PATH.test(pathname);
}

/**
 * Removes the URL, query string, body, headers and cookies from a Sentry
 * request on the beacon path. Returns whether it did, so the caller can skip
 * its own URL redaction. The caller still sends the event itself.
 *
 * Headers go whole: Sentry's IP scrub matches capitalized header names and
 * Node lowercases every header, so `x-forwarded-for`, `user-agent` and
 * `referer` would otherwise pair the visit with an IP and a browser.
 */
export function dropLandingVisitRequest(
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
  if (!request || !isLandingVisitBeacon(request.url, request.method)) {
    return false;
  }
  delete request.url;
  delete request.query_string;
  delete request.data;
  delete request.headers;
  delete request.cookies;
  return true;
}
