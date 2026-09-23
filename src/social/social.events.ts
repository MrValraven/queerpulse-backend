/**
 * One member blocked another.
 *
 * Emitted by BOTH block entry points — `SocialService.blockMember`
 * (`POST /blocks/:slug`) and `ConnectionsService.respond('block')`
 * (`PATCH /connections/:id`) — which already write the same `blocks` row and
 * the same `Blocked` connection edge, so a consumer never has to care which one
 * placed it.
 *
 * The consumer today is `ChatGateway`, which evicts BOTH members' sockets from
 * the DM room they share: a block is mutual severance, and
 * `ConversationsService.canJoinConversationLive` already refuses a fresh join
 * from either side. Without the eviction the pair keeps a live subscription to
 * a room neither of them may re-enter, so the blocker's messages and typing
 * indicators kept streaming to the blocked member until their socket
 * reconnected.
 *
 * A plain constants file with no providers, deliberately: `connections` already
 * depends on `social` (for `BlockFilterService`), and importing this from there
 * adds no module edge in either direction.
 */
export const MEMBER_BLOCKED = 'member.blocked';

export interface MemberBlockedEvent {
  blockerId: string;
  blockedId: string;
}

/**
 * One member lifted a block they had placed (PRD-363). Emitted post-commit by
 * both unblock entry points, `SocialService.unblockMember` and
 * `ConnectionsService.respond('unblock')`. The consumer is
 * `ConversationsService`, which puts back the DM's `openedAt` the block voided
 * once no block remains in either direction.
 */
export const MEMBER_UNBLOCKED = 'member.unblocked';

export interface MemberUnblockedEvent {
  unblockerId: string;
  unblockedId: string;
}

/**
 * Task 14: a member blocked a whole business, persona or company, placed by
 * `IdentityBlocksService.blockIdentity` (`POST /identity-blocks/:identityId`)
 * after its write returns, once per new block (a repeat block emits
 * nothing). The consumer is `ChatGateway`, which evicts the
 * member's sockets and every staff socket of that identity from the rooms of
 * every thread between them: a block of a business severs those threads for
 * both sides, and `ConversationsService.canJoinConversationLive` already
 * refuses a fresh join from either. Unblocking emits nothing, since a rejoin
 * passes through that same gate.
 */
export const IDENTITY_BLOCKED = 'identity.blocked';

export interface IdentityBlockedEvent {
  blockerUserId: string;
  identityId: string;
}
