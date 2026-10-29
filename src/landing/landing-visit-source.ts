import { BadRequestException } from '@nestjs/common';

/** The source label for a visit with no utm_source and no outside referrer. */
export const DIRECT_LANDING_SOURCE = 'direct';

/** Matches `landing_visit_daily.source` (varchar 64). */
export const LANDING_SOURCE_MAX_LENGTH = 64;

/**
 * Clamps a client-supplied source label into the stored shape: lowercase,
 * every character outside `[a-z0-9._-]` becomes `-`, leading and trailing
 * dashes are trimmed, and the result is cut to 64 characters. An empty result
 * becomes `direct`. Never rejects: any input maps to a valid label.
 *
 * The frontend applies the same rule before sending, so this is the server's
 * guarantee for clients that skip it.
 */
export function normalizeLandingSource(raw?: string): string {
  if (typeof raw !== 'string') return DIRECT_LANDING_SOURCE;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LANDING_SOURCE_MAX_LENGTH)
    .replace(/-+$/, '');
  return normalized.length > 0 ? normalized : DIRECT_LANDING_SOURCE;
}

/** The pages that count visits. Matches `landing_visit_daily.page`. */
export const LANDING_VISIT_PAGES = ['home', 'studio'] as const;
export type LandingVisitPage = (typeof LANDING_VISIT_PAGES)[number];

/** The page a visit belongs to when the beacon or the admin read names none. */
export const DEFAULT_LANDING_VISIT_PAGE: LandingVisitPage = 'home';

/**
 * Reads a page name from a query string. An absent value reads `home`; any
 * other value outside `LANDING_VISIT_PAGES` is a 400 with reason
 * `invalid_page`, in the shape of the admin route's `invalid_range`.
 */
export function parseLandingVisitPage(
  raw: string | undefined,
): LandingVisitPage {
  if (raw === undefined) return DEFAULT_LANDING_VISIT_PAGE;
  const matchingPage = LANDING_VISIT_PAGES.find(
    (allowedPage) => allowedPage === raw,
  );
  if (matchingPage === undefined) {
    throw new BadRequestException({
      message: `page must be one of ${LANDING_VISIT_PAGES.join(', ')}.`,
      reason: 'invalid_page',
    });
  }
  return matchingPage;
}
