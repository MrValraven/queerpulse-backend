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
}
