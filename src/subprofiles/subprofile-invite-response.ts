import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileInvite } from './entities/subprofile-invite.entity';

export interface MemberView {
  userId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  joinedAt: string;
  isCreator: boolean;
}

export function toMemberView(
  member: SubprofileMember,
  profile: Profile,
  creatorUserId: string,
): MemberView {
  return {
    userId: member.userId,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    slug: profile.slug,
    avatarUrl: toImageUrl(profile.avatarUrl),
    joinedAt: member.joinedAt.toISOString(),
    isCreator: member.userId === creatorUserId,
  };
}

export interface InviteView {
  id: string;
  subprofileId: string;
  invitedUserId: string;
  invitedByUserId: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  createdAt: string;
  // Denormalised invitee display for the persona's own pending list.
  invitedName: string;
  invitedSlug: string;
  invitedAvatarUrl: string | null;
}

export function toInviteView(
  invite: SubprofileInvite,
  invitedProfile: Profile,
): InviteView {
  return {
    id: invite.id,
    subprofileId: invite.subprofileId,
    invitedUserId: invite.invitedUserId,
    invitedByUserId: invite.invitedByUserId,
    status: invite.status,
    createdAt: invite.createdAt.toISOString(),
    invitedName:
      `${invitedProfile.firstName} ${invitedProfile.lastName}`.trim(),
    invitedSlug: invitedProfile.slug,
    invitedAvatarUrl: toImageUrl(invitedProfile.avatarUrl),
  };
}

// The invitee-scoped view (`GET invites/mine`): unlike `InviteView` (which
// denormalises the INVITEE for a persona's own pending-invite list), the
// invitee needs the PERSONA's identity (which they're being invited into) and
// who invited them — never their own profile.
export interface MyInviteView {
  id: string;
  subprofileId: string;
  personaName: string;
  personaAvatarUrl: string | null;
  invitedByName: string;
  createdAt: string;
  // Drives the accept-confirmation disclosure (IDN-2): an Unlinked persona is
  // marketed as pseudonymous, so accepting is the moment the invitee's real
  // identity first becomes visible to its other co-owners (and vice versa) —
  // the invitee needs to see that stated plainly before they accept, not
  // just after.
  linkVisibility: SubprofileLinkVisibility;
}

export function toMyInviteView(
  invite: SubprofileInvite,
  persona: Subprofile,
  inviterProfile: Profile,
): MyInviteView {
  return {
    id: invite.id,
    subprofileId: invite.subprofileId,
    personaName: persona.displayName,
    personaAvatarUrl: toImageUrl(persona.avatarUrl),
    invitedByName:
      `${inviterProfile.firstName} ${inviterProfile.lastName}`.trim(),
    createdAt: invite.createdAt.toISOString(),
    linkVisibility: persona.linkVisibility,
  };
}
