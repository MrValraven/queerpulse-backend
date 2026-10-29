/**
 * Keeps Studio payment values (IBANs, MB WAY numbers, payment links and payer
 * names) out of error reports.
 *
 * The request log and the HTTP metrics already carry no body, so Sentry is the
 * one path that can. Sentry 9's `httpIntegration` defaults to
 * `maxIncomingRequestBodySize: 'medium'`, which attaches the incoming request
 * body to every captured event as `request.data`. A 500 during a payment
 * method save, a purchase, a wall choice or a decline would therefore ship the
 * IBANs, MB WAY numbers, payment links and payer names just submitted to a
 * third-party service. The body is dropped for those four routes, whatever the
 * method.
 *
 * This rule stands apart from the Studio listening URL rule, so narrowing a
 * listening pattern later never ships a payment value.
 *
 * This module imports nothing: `instrument.ts` reads it before `Sentry.init`.
 */

const STUDIO_MONEY_BODY_PATTERNS = [
  /^(?:\/v\d+)?\/studio\/artists\/[^/]+\/payment-methods\/?$/i,
  /^(?:\/v\d+)?\/studio\/purchases\/?$/i,
  /^(?:\/v\d+)?\/studio\/purchases\/[^/]+\/wall\/?$/i,
  /^(?:\/v\d+)?\/studio\/artists\/[^/]+\/purchases\/[^/]+\/decline\/?$/i,
];

/**
 * Answers whether a request URL (absolute, or a path with an optional query
 * string) is one of the Studio money routes, with or without the `/v1` prefix
 * and a trailing slash, for any method. An absent or unparseable URL answers
 * false.
 */
export function isStudioMoneyRequestUrl(url: string | undefined): boolean {
  if (typeof url !== 'string' || url.length === 0) {
    return false;
  }
  try {
    const { pathname } = new URL(url, 'http://placeholder.invalid');
    return STUDIO_MONEY_BODY_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

/**
 * Removes the attached body from a Sentry request when it targets a Studio
 * money route. Every other request keeps its body.
 */
export function dropStudioMoneyRequestBody(
  request: { url?: string; data?: unknown } | undefined,
): void {
  if (request && isStudioMoneyRequestUrl(request.url)) {
    delete request.data;
  }
}
