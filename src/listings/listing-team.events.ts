/** Emitted after an invitation from a listing to a persona commits;
 *  `ListingTeamAlertsListener` tells the persona's members. The acting
 *  member's id is for block and mute filtering only. */
export const LISTING_TEAM_INVITED = 'listing_team.invited';

/** Emitted after a persona's request to join a listing commits; the listener
 *  tells the listing's owner and active co-managers. */
export const LISTING_TEAM_REQUESTED = 'listing_team.requested';

/** Emitted after either side accepts; the listener tells the side that
 *  started the link. Decline, cancel, remove and leave emit nothing. */
export const LISTING_TEAM_ACCEPTED = 'listing_team.accepted';

export interface ListingTeamAlertEvent {
  /** The `listing_team_members` row id. */
  memberId: string;
  actingUserId: string;
}

/** Emitted after a listing invites a member and the row commits; the listener
 *  tells that member only. The acting manager's id is for block and mute
 *  filtering only. */
export const LISTING_TEAM_MEMBER_INVITED = 'listing_team.member_invited';

/** Emitted after a member accepts a team invite; the listener tells the
 *  listing's owner and active co-managers, never the accepting member. */
export const LISTING_TEAM_MEMBER_ACCEPTED = 'listing_team.member_accepted';

/** Carried by both member events. Same shape as `ListingTeamAlertEvent`; here
 *  `actingUserId` is the inviting manager for the invite and the accepting
 *  member for the accepted event. */
export interface ListingTeamMemberAlertEvent {
  /** The `listing_team_members` row id. */
  memberId: string;
  actingUserId: string;
}

/** Client payload of `listing_team_member_invite`. */
export interface ListingTeamMemberInvitePayload {
  listingName: string;
  listingSlug: string;
  roleLabel: string | null;
}

/** Client payload of `listing_team_member_accepted`. */
export interface ListingTeamMemberAcceptedPayload {
  listingRef: string;
  listingName: string;
  listingSlug: string;
  memberName: string;
  memberSlug: string;
}
