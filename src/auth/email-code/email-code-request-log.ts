/**
 * Keeps email code request bodies (an email address and a sign-in code) out
 * of error reports.
 *
 * Sentry 9's `httpIntegration` attaches the incoming request body to every
 * captured event as `request.data`. A 500 during a code request or a verify
 * would ship that address and code to a third-party service. The body is
 * dropped for every email code route.
 *
 * This module imports nothing because `instrument.ts` reads it before
 * `Sentry.init`.
 */

const EMAIL_CODE_PATH_PATTERN =
  /^(?:\/v\d+)?\/auth\/email-code(?:\/[^?#]*)?\/?$/i;

/**
 * Answers whether a request URL (absolute, or a path with an optional query
 * string) is an email code route, with or without the `/v1` prefix. An absent
 * or unparseable URL answers false.
 */
export function isEmailCodeRequestUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const { pathname } = new URL(url, 'http://placeholder.invalid');
    return EMAIL_CODE_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Removes the attached body from a Sentry request when it targets an email
 * code route. Every other request keeps its body.
 */
export function dropEmailCodeRequestBody(
  request: { url?: string; data?: unknown } | undefined,
): void {
  if (request && isEmailCodeRequestUrl(request.url)) {
    delete request.data;
  }
}
