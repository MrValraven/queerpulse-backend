/**
 * Fired after a new member's account is created by redeeming an invite — the
 * "someone you invited joined" edge. Consumed by `NotificationsListener`, which
 * notifies the inviter and links to the new member's profile. Emitted only
 * after the signup transaction commits (a mid-transaction emit would survive a
 * rollback).
 */
export const INVITE_ACCEPTED = 'membership.invite_accepted';

export interface InviteAcceptedEvent {
  /** The member whose invite was redeemed — the notification recipient. */
  inviterId: string;
  /** The newly created member who redeemed it — the notification's actor. */
  newMemberId: string;
}
