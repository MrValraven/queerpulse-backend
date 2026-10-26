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
