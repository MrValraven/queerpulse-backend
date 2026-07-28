import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { Message } from './entities/message.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export function toMessageView(m: Message): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    replyToId: m.replyToId,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
  };
}

// ── Frontend-contract shapes ─────────────────────────────────────────────
// These mirror `AuthorSummary`/`MessageResponse`/`ConversationResponse` from
// the frontend's `src/shared/contracts/contracts.ts` exactly (field names
// included — `handle`/`displayName`, not this backend's internal
// `slug`/`firstName`+`lastName`). Every messaging HTTP read path returns these
// shapes; `MessageView` above is internal only (the MESSAGE_CREATED event
// payload and `POST /messages/request`).

export interface AuthorSummary {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ReactionSummary {
  key: MessageReactionKey;
  count: number;
  mine: boolean;
}

/** Fixed key order every reaction summary is rendered in, so the 6-entry
 *  array is stable regardless of which keys actually have rows. Mirrors
 *  `REACTION_KEY_ORDER` in `community-response.ts`. */
const REACTION_KEY_ORDER: MessageReactionKey[] = [
  MessageReactionKey.Love,
  MessageReactionKey.Laugh,
  MessageReactionKey.Like,
  MessageReactionKey.Wow,
  MessageReactionKey.Sad,
  MessageReactionKey.Thanks,
];

/**
 * Builds the 6-entry (one per `MessageReactionKey`, always present even at
 * count 0) summary for a single message from its raw reaction rows. `mine` is
 * true iff `viewerId` has a row for that key. Callers pass every reaction row
 * for the message — batched per page via an `IN` query, not a per-message
 * query — mirrors `toReactionSummaries` in `community-response.ts`.
 */
export function toMessageReactionSummaries(
  rows: Pick<MessageReaction, 'key' | 'userId'>[],
  viewerId: string,
): ReactionSummary[] {
  return REACTION_KEY_ORDER.map((key) => {
    const rowsForKey = rows.filter((r) => r.key === key);
    return {
      key,
      count: rowsForKey.length,
      mine: rowsForKey.some((r) => r.userId === viewerId),
    };
  });
}

export interface MessageResponse {
  id: string;
  conversationId: string;
  body: string;
  sender: AuthorSummary;
  createdAt: string;
  /** ISO timestamp of the last edit (author, within the edit window), else null. */
  editedAt: string | null;
  reactions: ReactionSummary[];
  /** ISO timestamp of a soft-delete (author or platform staff), else null. A
   *  tombstoned message keeps its id/sender/createdAt but `body` is blanked
   *  and `reactions` is emptied — see `toMessageResponses`. */
  deletedAt: string | null;
  /** The quoted message this one replies to, resolved server-side. Null if not a reply. */
  replyTo: {
    id: string;
    snippet: string;
    senderName: string;
    deleted: boolean;
  } | null;
}

/**
 * Builds `MessageResponse.replyTo` for a single message from the batch-fetched
 * reply parents/sender profiles in `toMessageResponses`. `null` when the
 * message isn't a reply. Otherwise: `deleted` is true when the parent itself
 * has since been soft-deleted OR is missing entirely (e.g. hard-removed by a
 * since-reverted migration) — in both cases `snippet` is blanked rather than
 * leaking stale content, and `senderName` falls back to "Someone" when the
 * parent's sender profile can't be resolved.
 */
export function buildReplyTo(
  replyToId: string | null,
  parentById: Map<
    string,
    Pick<Message, 'id' | 'body' | 'senderId' | 'deletedAt'>
  >,
  profileByUser: Map<string, Profile>,
): MessageResponse['replyTo'] {
  if (!replyToId) {
    return null;
  }
  const parent = parentById.get(replyToId);
  const deleted = Boolean(!parent || parent.deletedAt);
  const parentSenderProfile = parent
    ? profileByUser.get(parent.senderId)
    : undefined;
  return {
    id: replyToId,
    snippet: parent && !deleted ? parent.body.slice(0, 120) : '',
    senderName: parentSenderProfile
      ? `${parentSenderProfile.firstName} ${parentSenderProfile.lastName}`.trim() ||
        'Someone'
      : 'Someone',
    deleted,
  };
}

export interface ConversationResponse {
  id: string;
  type: 'dm' | 'group';
  otherParticipant: AuthorSummary | null;
  lastMessage: MessageResponse | null;
  unreadCount: number;
  updatedAt: string;
  /** The OTHER participant's read watermark (ISO), for "Seen" receipts. Null for
   *  official/group threads or a counterpart who has never read. */
  otherLastReadAt: string | null;
  /** The other participant's user id — used only client-side to correlate
   *  presence (`presence` events key by userId). Null for official/group. */
  otherParticipantId: string | null;
  // Backend extras beyond the frontend contract, which ignores unknown fields.
  // `isOfficial` distinguishes the org/welcome thread `type: 'group'` covers
  // coarsely; `muted` is this caller's per-conversation preference and is only
  // present where a participant row was already loaded (i.e. the list path).
  isOfficial?: boolean;
  muted?: boolean;
}

const UNKNOWN_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Member',
  avatarUrl: null,
};

function authorSummaryFrom(profile: Profile): AuthorSummary {
  return {
    handle: profile.slug,
    displayName: `${profile.firstName} ${profile.lastName}`.trim(),
    avatarUrl: toImageUrl(profile.avatarUrl),
  };
}

/** Maps a `Profile` to an `AuthorSummary`, or `null` when there isn't one. */
export function toAuthorSummary(
  p: Profile | undefined | null,
): AuthorSummary | null {
  return p ? authorSummaryFrom(p) : null;
}

/**
 * Same as `toAuthorSummary` but for call sites where the frontend contract
 * requires a non-null `AuthorSummary` (e.g. `MessageResponse.sender`). Falls
 * back to a generic placeholder in the defensive case where a sender's
 * profile can't be resolved (should not happen for an active participant).
 */
export function requireAuthorSummary(
  p: Profile | undefined | null,
): AuthorSummary {
  return p ? authorSummaryFrom(p) : UNKNOWN_AUTHOR;
}
