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
