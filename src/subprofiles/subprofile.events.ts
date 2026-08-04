export const SUBPROFILE_ENDORSED = 'subprofile.endorsed';

export interface SubprofileEndorsedEvent {
  subprofileId: string;
  endorserId: string;
  ownerId: string;
}

export const SUBPROFILE_FOLLOWED = 'subprofile.followed';

export interface SubprofileFollowedEvent {
  subprofileId: string;
  followerId: string;
  ownerId: string;
}

// Co-owner invite lifecycle — emitted by `SubprofileInvitesService`
// (`invite()` / `accept()`). Declared here, not there, so
// `NotificationsListener` (Task 5) can import typed constants/interfaces the
// same way it does for every other domain's events; the string values below
// MUST stay byte-identical to the literals that service emits.
export const SUBPROFILE_INVITED = 'subprofile.invited';

export interface SubprofileInvitedEvent {
  subprofileId: string;
  invitedUserId: string;
  invitedByUserId: string;
  displayName: string;
}

export const SUBPROFILE_INVITE_ACCEPTED = 'subprofile.invite.accepted';

export interface SubprofileInviteAcceptedEvent {
  subprofileId: string;
  joinedUserId: string;
  invitedByUserId: string;
}
