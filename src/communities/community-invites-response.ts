import { MemberRef } from '../common/member-ref';
import { CommunityCardDTO } from './community-response';
import { CommunityInvite } from './entities/community-invite.entity';

/**
 * Why one named member was passed over by
 * `POST /communities/:slug/invites`. Reported back per slug rather than
 * failing the whole call: an owner pasting a list of ten people should not
 * have the request rejected because one of them joined yesterday, and should
 * still be told which ones did not get an invite and why.
 */
export enum CommunityInviteSkipReason {
  /** No active member has this profile slug. */
  UnknownMember = 'unknown_member',
  /** The inviter named themselves. */
  Self = 'self',
  /** A house/system account (`users.is_system`), which is never invited. */
  SystemAccount = 'system_account',
  /** Already on the roster, so there is nothing to invite them to. */
  AlreadyMember = 'already_member',
  /**
   * Already has a pending join request. They asked first; the answer belongs
   * in the triage queue, and an invite would talk past it.
   */
  PendingJoinRequest = 'pending_request',
  /** Barred from this community (`community_bans`). */
  Banned = 'banned',
  /**
   * Already holds a pending invitation to this community
   * (`UQ_community_invites_pending`). The invitation on file is the answer:
   * re-inviting somebody does not send a second bell, because a nudge every
   * time a moderator re-opens the invite panel is a nudge nobody consented
   * to. See `CommunityInvite`'s docstring.
   */
  AlreadyInvited = 'already_invited',
}

export interface CommunityInviteSkipDTO {
  slug: string;
  reason: CommunityInviteSkipReason;
}

/**
 * `POST /communities/:slug/invites` — a summary of what the call actually
 * did. `invited` holds the profile slugs that were sent a
 * `CommunityInviteReceived` notification; `skipped` names everyone else with
 * the reason. Hand-mapped like every other response in this module (there is
 * no global serializer here), and deliberately carries no user ids.
 *
 * Note on `invited`: it means "an invite was sent", not "a notification row
 * exists". `NotificationsService.createForRecipients` still drops recipients
 * who blocked or muted the inviter, or who turned this category off, and that
 * filtering is private to the recipient. Reporting it back would leak a block
 * to the person blocked.
 */
export interface CommunityInvitesResponseDTO {
  invited: string[];
  skipped: CommunityInviteSkipDTO[];
  invitedCount: number;
  skippedCount: number;
}

/**
 * One standing invitation, as its INVITEE sees it
 * (`GET /me/community-invites`).
 *
 * The community is carried as the ordinary `CommunityCardDTO` the discover
 * grid already renders, so an invitations shelf is the same card the rest of
 * the app uses rather than a second, thinner shape nobody styles. This is the
 * only place a `private` community's card reaches somebody who is not on its
 * roster, and a pending invitation is exactly the standing that earns it.
 *
 * `invitedBy` is null when the moderator who sent it has since erased their
 * account (the actor FK is `ON DELETE SET NULL`): the invitation still
 * stands, it just no longer names a person.
 */
export interface MyCommunityInviteDTO {
  id: string;
  community: CommunityCardDTO;
  invitedBy: MemberRef | null;
  createdAt: string;
}

/**
 * One standing invitation, as the community's OWN STAFF see it
 * (`GET /communities/:slug/invites`). Pending only: an answered invitation is
 * the invitee's business, and surfacing "she declined you" to a room's
 * moderators is a pressure nobody invited.
 */
export interface CommunityPendingInviteDTO {
  id: string;
  member: MemberRef;
  invitedBy: MemberRef | null;
  createdAt: string;
}

export function toMyCommunityInvite(
  invite: CommunityInvite,
  community: CommunityCardDTO,
  invitedBy: MemberRef | null,
): MyCommunityInviteDTO {
  return {
    id: invite.id,
    community,
    invitedBy,
    createdAt: invite.createdAt.toISOString(),
  };
}

export function toCommunityPendingInvite(
  invite: CommunityInvite,
  member: MemberRef,
  invitedBy: MemberRef | null,
): CommunityPendingInviteDTO {
  return {
    id: invite.id,
    member,
    invitedBy,
    createdAt: invite.createdAt.toISOString(),
  };
}
