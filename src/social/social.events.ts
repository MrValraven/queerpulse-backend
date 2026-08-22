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
