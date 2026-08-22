import { MessageReactionKey } from './entities/message-reaction.entity';
import { MessageResponse, MessageView } from './message-response';

export const MESSAGE_CREATED = 'message.created';
/**
 * A brand-new conversation (currently: a group) was created. Fanned to each
 * member's `user:<id>` room as the `conversation:new` socket frame so their
 * inbox refetches live — the members were not yet in the conversation room when
 * it was created, so `message:new` (room-scoped) would not reach them.
 */
export const CONVERSATION_CREATED = 'conversation.created';
export const MESSAGE_UPDATED = 'message.updated';
export const MESSAGE_READ = 'message.read';
export const MESSAGE_DELIVERED = 'message.delivered';
export const MESSAGE_REACTION = 'message.reaction';
export const MESSAGE_DELETED = 'message.deleted';
export const MESSAGE_PINNED = 'message.pinned';
/**
 * A member's LIVE access to a conversation was revoked — they were removed from
 * a group, left one, or a block severed the DM pair.
 *
 * Purely a socket-room instruction: `ChatGateway` evicts every socket in each
 * listed member's `user:<id>` room from the conversation room
 * (`socketsLeave`). Without it, room authorisation was a one-shot check at
 * `conversation:join` time and every later broadcast (`message:new`, `typing`,
 * `read`, `message:delivered`, `reaction`, `message:deleted`,
 * `message:pinned`) is a blind room emit — so a removed member or a blocked DM
 * counterpart kept receiving message bodies live until their socket happened to
 * reconnect (up to the 15-minute access-token lifetime, longer if the tab
 * refreshed the cookie first). The HTTP read path's `leftAt` ceiling and the
 * `canJoinConversationLive` gate were both silently undone by that gap.
 *
 * Emitted post-commit and best-effort: a socket relay failure must never fail a
 * membership write that already committed.
 */
export const CONVERSATION_MEMBERSHIP_REVOKED =
  'conversation.membership.revoked';

export interface MessageCreatedEvent {
  conversationId: string;
  /** Internal shape — consumed by the push + notification listeners (they read
   *  `senderId`/`body`). */
  message: MessageView;
  /** Frontend-contract shape the gateway relays to conversation rooms as
   *  `message:new`, so live clients can patch it straight into the thread cache
   *  (no refetch) and reconcile the sender's optimistic bubble by
   *  `clientMessageId`. */
  response: MessageResponse;
}

export interface MessageUpdatedEvent {
  conversationId: string;
  /**
   * The frontend-contract shape, HYDRATED — not the internal `MessageView`.
   *
   * `toMessageResponses` is what blanks the body of a message a moderator has
   * taken down; relaying the raw view meant an edit inside the 15-minute window
   * pushed the new body to every connected participant even for a message that
   * was already hidden. (`editMessage` now refuses that edit outright, so this
   * is the second of two locks on the same door.) The frontend's
   * `message:updated` contract already declares `MessageResponse` and reads
   * only `id`/`body`/`editedAt`, all of which both shapes carry.
   */
  message: MessageResponse;
}

export interface ConversationCreatedEvent {
  conversationId: string;
  /** Every participant of the new conversation (creator included). The gateway
   *  relays `conversation:new` to each one's `user:<id>` room. */
  memberUserIds: string[];
}

export interface MessageReadEvent {
  conversationId: string;
  userId: string;
  lastReadAt: Date;
}

export interface MessageDeliveredEvent {
  conversationId: string;
  /** The participant who received (acked) — the SENDER of the messages this
   *  receipt covers reads it to advance their "delivered" (double-check) tick. */
  userId: string;
  deliveredAt: Date;
}

/** One key's authoritative count after a reaction change — viewer-agnostic (no
 *  `mine`, which is per-recipient), so a single broadcast frame is correct for
 *  every client in the room. */
export interface MessageReactionCount {
  key: MessageReactionKey;
  count: number;
}

export interface MessageReactionEvent {
  conversationId: string;
  messageId: string;
  /** Who added/removed the reaction. Lets a live client skip the echo of its
   *  OWN reaction (whose optimistic patch already applied), so the absolute
   *  counts below never double-apply on top of the reactor's local delta. */
  userId: string;
  /** Authoritative per-key counts for the message AFTER the change, so clients
   *  patch the chip counts in place (each keeping its own `mine`) instead of
   *  refetching the whole thread on every reaction. */
  reactions: MessageReactionCount[];
}

/** See {@link CONVERSATION_MEMBERSHIP_REVOKED}. `userIds` may hold more than
 *  one member (a block severs the room for BOTH sides of the DM pair). */
export interface ConversationMembershipRevokedEvent {
  conversationId: string;
  userIds: string[];
}

export interface MessageDeletedEvent {
  conversationId: string;
  messageId: string;
}

/**
 * A message was pinned or unpinned in a conversation. Pins are SHARED, so this
 * is relayed to the whole conversation room; each client refreshes just the
 * pinned-messages list (and patches the message's pin state) rather than
 * refetching the whole thread.
 */
export interface MessagePinnedEvent {
  conversationId: string;
  messageId: string;
  pinned: boolean;
}
