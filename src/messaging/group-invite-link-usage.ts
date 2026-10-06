import { Conversation } from './entities/conversation.entity';

/**
 * PRD-400 (use cap): the only use caps an owner or admin may put on a
 * group's join-by-link token. `null` (sent or omitted) means unlimited, the
 * default, so a link created without a choice behaves exactly as before.
 * `CreateInviteLinkDto` validates against this list, and the frontend's
 * invite-link panel offers the same values.
 */
export const GROUP_INVITE_LINK_MAX_USES_OPTIONS = [1, 5, 25] as const;

export type GroupInviteLinkMaxUses =
  (typeof GROUP_INVITE_LINK_MAX_USES_OPTIONS)[number];

/**
 * PRD-400 (use cap): the link usage an owner or admin sees beside the live
 * invite link. `inviteTokenMaxUses` is the cap (null for unlimited) and
 * `inviteTokenUsesLeft` how many more people can still join with it (null for
 * unlimited, 0 once used up). Both null whenever the caller may not see the
 * token, or there is none.
 *
 * Kept here, spread into the group `ConversationResponse` builders by
 * `inviteLinkUsageFields`, until `message-response.ts`'s
 * `ConversationResponse` declares these two fields itself.
 */
export interface GroupInviteLinkUsage {
  inviteTokenMaxUses: number | null;
  inviteTokenUsesLeft: number | null;
}

/** `POST /conversations/:id/invite-link` response: the live token, when it
 *  expires (PRD-400) and its use cap with the uses left. */
export interface GroupInviteLinkResponse extends GroupInviteLinkUsage {
  inviteToken: string;
  inviteTokenExpiresAt: string;
}

/** How many more joins the conversation's live token allows: null for an
 *  unlimited link, floored at 0. */
export function inviteLinkUsesLeft(
  convo: Pick<Conversation, 'inviteTokenMaxUses' | 'inviteTokenUseCount'>,
): number | null {
  if (convo.inviteTokenMaxUses == null) return null;
  return Math.max(
    0,
    convo.inviteTokenMaxUses - (convo.inviteTokenUseCount ?? 0),
  );
}

/** True once a capped link has seated as many newcomers as its cap allows. */
export function isInviteLinkUsedUp(
  convo: Pick<Conversation, 'inviteTokenMaxUses' | 'inviteTokenUseCount'>,
): boolean {
  return inviteLinkUsesLeft(convo) === 0;
}

/**
 * The usage fields for a group `ConversationResponse`, under exactly the rule
 * that gates `inviteToken` itself: `canSeeInviteToken` is true only for an
 * active owner or admin of a live group. Both fields are null otherwise, and
 * whenever there is no live token.
 */
export function inviteLinkUsageFields(
  convo: Pick<
    Conversation,
    'inviteToken' | 'inviteTokenMaxUses' | 'inviteTokenUseCount'
  >,
  canSeeInviteToken: boolean,
): GroupInviteLinkUsage {
  if (!canSeeInviteToken || !convo.inviteToken) {
    return { inviteTokenMaxUses: null, inviteTokenUsesLeft: null };
  }
  return {
    inviteTokenMaxUses: convo.inviteTokenMaxUses ?? null,
    inviteTokenUsesLeft: inviteLinkUsesLeft(convo),
  };
}
