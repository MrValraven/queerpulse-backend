/**
 * The wire shape of the volunteer-hours report (`GET
 * /admin/volunteering/hours`).
 *
 * Hand-mapped from `VolunteerHoursTotalsDTO` rather than returned as-is, for
 * two reasons. The service's per-community rows carry a raw `communityId` and
 * nothing a human can read, so this layer resolves each one to its slug and
 * name. And the service's breakdown lists are capped, which the caller has to
 * be told about: a silently truncated list reads as "this is everything", and
 * this report exists precisely so a number can be shown to a funder.
 *
 * WHAT IS DELIBERATELY ABSENT: any per-member row. There is no leaderboard of
 * who volunteered most and there will not be one. Aggregate operational counts
 * the team already computes are fine; ranking members by their behaviour is
 * not, and the service has no such query to expose in the first place.
 */

export interface AdminVolunteerHoursOpportunityRowDTO {
  opportunitySlug: string;
  role: string;
  org: string;
  sessionCount: number;
  hoursContributed: number;
}

export interface AdminVolunteerHoursCommunityRowDTO {
  /** Kept as the row's stable identity: a community whose row cannot be
   *  resolved (renamed away, removed) still has to appear, because its hours
   *  are already counted in the platform total above it. */
  communityId: string;
  /** Null when the id no longer resolves to a community. */
  communitySlug: string | null;
  communityName: string | null;
  sessionCount: number;
  hoursContributed: number;
}

export interface AdminVolunteerHoursDTO {
  /** The window actually applied, echoed back so the report can be labelled
   *  with the period it covers. Null means unbounded on that side. */
  from: string | null;
  to: string | null;
  /** Confirmed (attended) sessions, hours, and how many DISTINCT people
   *  contributed them. Exact over the whole window regardless of the
   *  breakdown cap below. */
  sessionCount: number;
  hoursContributed: number;
  volunteerCount: number;
  byOpportunity: AdminVolunteerHoursOpportunityRowDTO[];
  byCommunity: AdminVolunteerHoursCommunityRowDTO[];
  /** How many rows a breakdown list can hold at most. */
  breakdownLimit: number;
  /** True when the matching list hit that ceiling, so the page can say the
   *  list is partial instead of implying it is the whole picture. */
  isOpportunityBreakdownCapped: boolean;
  isCommunityBreakdownCapped: boolean;
}
