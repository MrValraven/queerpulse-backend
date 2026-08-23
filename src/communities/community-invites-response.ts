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
