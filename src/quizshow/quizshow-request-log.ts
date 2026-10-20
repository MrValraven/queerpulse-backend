/**
 * Keeps Pulse Live request bodies (join codes, quiz text, answers) out of
 * error reports.
 *
 * Sentry 9's `httpIntegration` attaches the incoming request body to every
 * captured event as `request.data`. A 500 during a join, an import or a
 * session call would ship that body to a third-party service. The body is
 * dropped for every Pulse Live route; the URL names only the event slug and
 * stays.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const QUIZSHOW_PATH_PATTERN =
  /^(?:\/v\d+)?\/(?:events\/[^/]+\/quizshow|quizshow)(?:\/[^?#]*)?\/?$/i;

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
 * Removes the attached body from a Sentry request when it targets a Pulse
 * Live route. Every other request keeps its body.
 */
export function dropQuizshowRequestBody(
  request: { url?: string; data?: unknown } | undefined,
): void {
  if (request && isQuizshowRequestUrl(request.url)) {
    delete request.data;
  }
}
