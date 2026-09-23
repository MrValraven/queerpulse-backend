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

// Emitted by `SubprofilesService.remove()` AFTER a persona is deleted, so its
// co-owners learn it is gone (the creator who deleted it is excluded).
// `coOwnerIds` is captured before the `subprofile_members` rows cascade away —
// the listener fans a `SubprofileDeleted` notification out to them.
export const SUBPROFILE_DELETED = 'subprofile.deleted';

export interface SubprofileDeletedEvent {
  subprofileId: string;
  displayName: string;
  deletedByUserId: string;
  coOwnerIds: string[];
}

// Emitted by `SubprofilesService.removeMember()` AFTER a co-owner is evicted by
// the persona creator, so the removed member learns they no longer co-own it
// (before this, a creator kick emitted nothing). Mirrors `SUBPROFILE_DELETED`:
// the removing creator is the actor (block/mute applies via `removedByUserId`),
// the payload carries the persona name for display, and it fires post-commit.
export const SUBPROFILE_MEMBER_REMOVED = 'subprofile.member.removed';

export interface SubprofileMemberRemovedEvent {
  subprofileId: string;
  displayName: string;
  removedUserId: string;
  removedByUserId: string;
}

// Emitted by `SubprofileMembershipService` AFTER the creator role of a persona
// has moved to another co-owner (the creator left, or their account was
// erased), once the transaction that moved it has committed. The listener
// tells every remaining member who creates the persona now. The payload names
// the persona and its new creator only: the member who left is deliberately
// absent, so no notification can name them. `memberUserIds` is every member
// still on the roster, the new creator included.
export const SUBPROFILE_CREATOR_CHANGED = 'subprofile.creator.changed';

export interface SubprofileCreatorChangedEvent {
  subprofileId: string;
  displayName: string;
  newCreatorUserId: string;
  memberUserIds: string[];
}
