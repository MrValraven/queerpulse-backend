/**
 * `GET /communities/:slug/insights` — plain aggregate counts (never
 * per-member behavior tracking; this is the "community's own leadership
 * looking at their own community's shape" case the platform's
 * no-user-behavior-analytics rule explicitly carves out room for) for a
 * community's owner/mods. `memberCount` mirrors `CommunityStats.memberCount`
 * (`community-response.ts`); the rest are new — a growth trend
 * (`newMembersThisWeek`/`newMembersThisMonth`) and a post-volume trend
 * (`postCount`/`postsThisWeek`/`activeMemberCount7d`) neither the roster nor
 * the community card currently expose.
 */
export interface CommunityInsightsResponse {
  memberCount: number;
  newMembersThisWeek: number;
  newMembersThisMonth: number;
  postCount: number;
  postsThisWeek: number;
  /** Distinct authors of a post or reply in this community in the last 7 days. */
  activeMemberCount7d: number;
  /**
   * Growing or fading. Twelve weekly buckets each, oldest first, ALWAYS
   * exactly `INSIGHTS_TREND_WEEKS` points long including the current partial
   * week: a week with nothing in it is a zero, so the client can plot the
   * series straight through without reasoning about gaps. See
   * `CommunityTrendPoint`.
   */
  newMembersByWeek: CommunityTrendPoint[];
  postsByWeek: CommunityTrendPoint[];
}

/** How many weekly buckets the two trend series carry. */
export const INSIGHTS_TREND_WEEKS = 12;

/**
 * One weekly bucket in an insights trend. `weekStart` is the ISO calendar
 * week's Monday as a plain `YYYY-MM-DD` date in UTC, so the buckets are stable
 * regardless of where the reader or the server sits, and `count` is a volume,
 * never a list of who.
 *
 * These stay aggregate on purpose: the series says how many members joined or
 * how many posts landed in a week and nothing about WHICH member did what.
 * Per-member activity tracking is out of bounds on this platform, and a trend
 * line is not a reason to reach for it.
 */
export interface CommunityTrendPoint {
  weekStart: string;
  count: number;
}
