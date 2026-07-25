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
