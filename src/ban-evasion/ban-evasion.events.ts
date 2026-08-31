import { RemovalKind } from './entities/removed-account-signal.entity';

/**
 * The event this module listens for from outside it.
 *
 * Emitted by whoever actually closes a door on an account: the platform
 * enforcement path when a `ban` lands, and the community bans service when a
 * community ban lands. Those services own their own transactions and their own
 * files, so this module never reaches into them. It listens, and does its
 * writing on its own.
 *
 * Emit AFTER the ban has committed. The listener does an independent write and
 * a failure inside it must never roll back the ban itself: a ban that took
 * effect with no evasion record is a missing flag later, while a ban that got
 * rolled back because a flag failed to record is a member walking free now.
 */
export const ACCOUNT_REMOVED = 'ban_evasion.account_removed';

export interface AccountRemovedEvent {
  /** The account that was removed. */
  userId: string;
  removalKind: RemovalKind;
  /** The community for a community ban; null for a platform ban. */
  communityId: string | null;
  /** When the removal landed. */
  removedAt: Date;
}

/**
 * A community's owner, co-owner or moderator has handed platform staff a
 * ban-evasion question about one join-request applicant (PRD-31).
 *
 * Emitted by `CommunityBanEvasionService.escalate` ONLY when a row is actually
 * inserted. `escalate` is idempotent while an escalation is open: a second press
 * of the button, and the loser of the two-moderators-at-once insert race, both
 * return the EXISTING row, and neither emits. Staff hear about a case once,
 * which is what "one open escalation per (community, join request)" means on the
 * notification side too.
 *
 * Emit AFTER the escalation has committed, and treat the emit as best effort:
 * the question is already recorded and visible on `/admin/ban-evasion`, so a
 * listener failure costs a ping, while an emit that could throw back into
 * `escalate` would cost the moderator their escalation.
 */
export const BAN_EVASION_ESCALATION_RAISED = 'ban_evasion.escalation_raised';

export interface BanEvasionEscalationRaisedEvent {
  /** The `ban_evasion_escalations` row that was just inserted. */
  escalationId: string;
  /** The community whose moderator raised it. */
  communityId: string;
  /** The `community_join_requests` row being asked about. */
  joinRequestId: string;
  /**
   * The moderator who pressed the button. Carried so a listener can leave them
   * out of a fan-out; it is deliberately NOT put on the notification as an
   * actor, because staff duty mail must not be droppable by a block or mute.
   */
  raisedByUserId: string;
}

/**
 * Platform staff have closed one escalation (PRD-31).
 *
 * Emitted by `BanEvasionEscalationsService.resolve` after the row has committed,
 * best effort, for the same reason as above: the resolution is already recorded
 * and a second resolve is refused, so a listener failure costs a ping and never
 * a lost decision.
 *
 * THIS EVENT CARRIES NO PART OF WHAT STAFF FOUND, AND MUST NEVER BE WIDENED TO.
 * No `resolutionNote`, no `resolvedByUserId`, no `resolvedAt`, no assessment, no
 * tier, no score, no matched signal. The recipient of anything built from this
 * event is the community moderator who raised it, and that moderator is exactly
 * the person the one-bit design of `CommunityBanEvasionFlagDTO` exists to
 * withhold a cross-community judgement from. They asked a question and they
 * learn that somebody looked and the case is closed. Everything else stays on
 * the staff console, where `BanEvasionEscalationDTO` serves it to the people who
 * can see the whole picture.
 *
 * If a future reader wants the note here "so the copy can be more helpful", that
 * is a product decision to re-take with the privacy call it carries, and it is
 * not a field to add because the data is one join away.
 */
export const BAN_EVASION_ESCALATION_RESOLVED =
  'ban_evasion.escalation_resolved';

export interface BanEvasionEscalationResolvedEvent {
  /** The `ban_evasion_escalations` row that was just closed. */
  escalationId: string;
  /** The community whose moderator raised it. */
  communityId: string;
  /** The `community_join_requests` row it was about. */
  joinRequestId: string;
  /**
   * The moderator who raised it, and the only person told about the closure.
   * Null once their account has been erased, which leaves nobody to tell.
   */
  raisedByUserId: string | null;
}
