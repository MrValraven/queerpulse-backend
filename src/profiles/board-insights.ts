/** How many reciprocal matches one post surfaces. */
export const BOARD_MATCHES_PER_POST = 3;
/** The trailing window the funnel counts over, matching the Now section's. */
export const BOARD_INSIGHTS_WINDOW_DAYS = 90;

/** A member whose own board post answers one of yours. */
export interface BoardMatchView {
  slug: string;
  first: string;
  /** The MATCHED post's kind, which is always the opposite of yours. */
  kind: 'looking' | 'offering';
  postSlug: string;
}

/**
 * Owner-only board figures. Kept off the single-profile read so a visitor's
 * payload stays flat, mirroring `now-insights`.
 */
export interface BoardInsightsView {
  hellos: number;
  replies: number;
  windowDays: number;
  /** Keyed by the owner's own post slug. */
  matches: Record<string, BoardMatchView[]>;
}
