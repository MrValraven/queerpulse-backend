/**
 * Keeps community giving values (IBANs, MB WAY numbers, payment links) out of
 * error reports.
 *
 * The request log and the HTTP metrics already carry no body, so Sentry is the
 * one path that can. Sentry 9's `httpIntegration` defaults to
 * `maxIncomingRequestBodySize: 'medium'`, which attaches the incoming request
 * body to every captured event as `request.data`. A 500 during a
 * `PUT /communities/:slug/giving` would therefore ship every IBAN and phone
 * number the owner just submitted to a third-party service. The body is
 * dropped for that route; the URL names only the community slug and stays.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const COMMUNITY_GIVING_PATH_PATTERN =
  /^(?:\/v\d+)?\/communities\/[^/]+\/giving\/?$/i;

/**
 * Answers whether a request URL (absolute, or a path with an optional query
 * string) is the community giving route, with or without the `/v1` prefix and
 * a trailing slash. An absent or unparseable URL answers false.
 */
export function isCommunityGivingRequestUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const { pathname } = new URL(url, 'http://placeholder.invalid');
    return COMMUNITY_GIVING_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Removes the attached body from a Sentry request when it targets the
 * community giving route. Every other request keeps its body.
 */
export function dropCommunityGivingRequestBody(
  request: { url?: string; data?: unknown } | undefined,
): void {
  if (request && isCommunityGivingRequestUrl(request.url)) {
    delete request.data;
  }
}
