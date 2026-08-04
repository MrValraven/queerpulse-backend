import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { ConversationRole } from './entities/conversation-participant.entity';
import {
  GifAttachment,
  Message,
  MessageKind,
  SystemEvent,
  SystemEventType,
} from './entities/message.entity';
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
  clientMessageId: string | null;
  forwarded: boolean;
  kind: MessageKind;
  systemEvent: SystemEvent | null;
  attachment: GifAttachment | null;
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
    clientMessageId: m.clientMessageId,
    forwarded: m.forwarded,
    kind: m.kind,
    systemEvent: m.systemEvent,
    attachment: m.attachment,
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
  /** Set on the SENDER's own outgoing message once the recipient's delivered
   *  watermark has reached it (their device acked receipt) — the ISO of that
   *  watermark, a truthful upper bound on when it arrived. Null when not yet
   *  delivered, and for messages the viewer received (delivery to the viewer is
   *  not rendered). Drives the WhatsApp-style "double check". Distinct from
   *  `deletedAt` and from the read/"seen" watermark (which outranks it). */
  deliveredAt: string | null;
  /** The sender's client-generated idempotency id (`crypto.randomUUID()`), echoed
   *  back so the optimistic outbox bubble reconciles against its server row by
   *  the same key (replace-in-place, no duplicate). Null for server-originated
   *  or legacy messages that carry no client id. */
  clientMessageId: string | null;
  /** True when this message was created by forwarding — the recipient's bubble
   *  renders a subtle "Forwarded" label. Only the body is carried on a forward;
   *  reactions/receipts are never copied. */
  forwarded: boolean;
  /** ISO timestamp this message was pinned in the conversation (SHARED — both
   *  participants see the same value), else null. Drives the pin indicator + the
   *  pinned-messages banner. */
  pinnedAt: string | null;
  /** Whether THIS viewer has starred (privately bookmarked) the message. Scoped
   *  to the caller — never leaks the other participant's stars. */
  starred: boolean;
  /** Server-authoritative: whether this viewer may pin/unpin this message. True
   *  for any non-deleted message a DM participant can see (the endpoint re-checks
   *  participation); false for tombstones. Groups may narrow this later. */
  canPin: boolean;
  /** Server-authoritative: whether this viewer may edit this message's body.
   *  True iff the viewer is the author AND the message is within the same
   *  `EDIT_WINDOW_MS` of `createdAt` that `MessagesService.editMessage` itself
   *  enforces — computed from the identical constant so this flag can never
   *  drift from what the edit endpoint would actually accept. False for a
   *  tombstone (the edit endpoint 404s a deleted message). */
  canEdit: boolean;
  /** Server-authoritative: whether this viewer may delete this message. True
   *  for the author OR a platform admin/moderator — mirrors
   *  `MessagesService.deleteMessage`'s own actor check exactly. False for an
   *  already-deleted message (deleting again is a harmless no-op server-side,
   *  but there is nothing left to delete). */
  canDelete: boolean;
  /** Server-authoritative: whether this viewer may report this message. True
   *  for any non-deleted message the viewer did not author — reporting your
   *  own message, or a tombstone with no content left, is never offered. */
  canReport: boolean;
  /** The quoted message this one replies to, resolved server-side. Null if not a reply. */
  replyTo: {
    id: string;
    snippet: string;
    senderName: string;
    deleted: boolean;
  } | null;
  /** `user` (an ordinary bubble) or `system` (a rendered event pill). Present on
   *  every message; a DM's messages are all `user`, so the client's existing
   *  bubble path is unchanged. */
  kind: 'user' | 'system' | 'gif';
  /** Resolved system event for a `system` message, else null. Actor/target are
   *  resolved to DISPLAY NAMES server-side (the client only renders bilingual
   *  templates, never user ids). `value` carries a scalar the event needs (e.g. a
   *  new group title). */
  systemEvent: {
    type: SystemEventType;
    actorName: string;
    targetName: string | null;
    value: string | null;
  } | null;
  /** Provider-hosted GIF for a `kind:'gif'` message, else null. The client
   *  renders it as an inline image; `body` carries a "GIF" text fallback. */
  attachment: GifAttachment | null;
}

/**
 * One member of a GROUP conversation, for the group header/info list. `id` is the
 * user id (correlates presence + the leave call); `role` drives the read-only
 * role badge Phase 1 shows and the management Phase 2 gates on. DMs carry an
 * empty `members` array — the counterpart is `otherParticipant` as before.
 */
export interface ConversationMemberSummary {
  id: string;
  /** Profile handle (slug) — the member's profile link + avatar tint seed. */
  handle: string;
  name: string;
  avatarUrl: string | null;
  role: ConversationRole;
  /** This member's read watermark (ISO), else null. Surfaced per-member so the
   *  client computes "Seen by N" for the caller's own group messages without an
   *  N+1 per-message receipts fetch — a message is "seen by" a member iff this
   *  is at-or-after the message's `createdAt`. Null for a member who has never
   *  read (and always null on DM member lists, which are empty). */
  lastReadAt: string | null;
  /** This member's delivered watermark (ISO), one rung below `lastReadAt`, else
   *  null. Lets the client show a group "delivered" state precede "seen by". */
  deliveredAt: string | null;
}

/**
 * Resolves a stored `SystemEvent` (actor/target as user ids) into the
 * display-name shape the client renders. Names come from the batch-loaded
 * profiles so a later rename is always reflected; a missing profile falls back
 * to a generic "Member". `null` in → `null` out (a `user` message).
 */
export function buildSystemEvent(
  event: SystemEvent | null,
  profileByUser: Map<string, Profile>,
): MessageResponse['systemEvent'] {
  if (!event) {
    return null;
  }
  const nameOf = (userId: string | undefined): string | null => {
    if (!userId) return null;
    const profile = profileByUser.get(userId);
    return profile ? requireAuthorSummary(profile).displayName : 'Member';
  };
  return {
    type: event.type,
    actorName: nameOf(event.actorId) ?? 'Member',
    targetName: nameOf(event.targetId),
    value: event.value ?? null,
  };
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
  /** The OTHER participant's delivered watermark (ISO), for the "double check".
   *  Mirrors `otherLastReadAt` one rung down. Null for official/group threads or
   *  a counterpart whose device hasn't acked anything yet. */
  otherDeliveredAt: string | null;
  /** The other participant's user id — used only client-side to correlate
   *  presence (`presence` events key by userId). Null for official/group. */
  otherParticipantId: string | null;
  /** `direct` (1:1 DM / official) or `group` (member-created, titled,
   *  multi-participant). The client branches its header/inbox/attribution on
   *  this; DMs stay `direct` and render exactly as before. */
  kind: 'direct' | 'group';
  /** Group name (null for DMs — their name is the counterpart's). */
  title: string | null;
  /** Group avatar URL (null for DMs — the counterpart's avatar is used). */
  avatarUrl: string | null;
  /** Active (not-left) member count for a group; 0 for DMs. Drives the header
   *  subtitle ("5 members"). */
  memberCount: number;
  /** Group member roster (empty for DMs). Read-only in Phase 1 (role badges);
   *  Phase 2 adds add/remove/promote. */
  members: ConversationMemberSummary[];
  // Backend extras beyond the frontend contract, which ignores unknown fields.
  // `isOfficial` distinguishes the org/welcome thread `type: 'group'` covers
  // coarsely; `muted` is this caller's per-conversation preference and is only
  // present where a participant row was already loaded (i.e. the list path).
  isOfficial?: boolean;
  muted?: boolean;
  /** For a group: whether THIS caller has left it (`left_at` set). A left member
   *  keeps read access to history but the composer is severed. Absent/false for
   *  DMs and active group members. */
  hasLeft?: boolean;
  /** This caller's own standing in a group (`owner`\|`admin`\|`member`), for the
   *  info UI. Null/absent for DMs. */
  myRole?: ConversationRole | null;
  /** SERVER-AUTHORITATIVE capability flags for group management — the client
   *  gates its management UI on these, and every mutation re-checks the caller's
   *  role server-side regardless (never trusting the client). All false for DMs,
   *  official threads, and a member who has left. `owner` gets everything incl.
   *  role management; `admin` can add/remove/rename but not manage roles;
   *  `member` gets none. */
  canAddMembers?: boolean;
  canRemoveMembers?: boolean;
  canRename?: boolean;
  canManageRoles?: boolean;
}

/**
 * One cross-conversation message-search hit (see `MessagingService.searchMessages`).
 * Carries just enough to render a result row and navigate to it: the message and
 * conversation ids for the jump, a server-windowed `snippet` around the match
 * (the full body is never returned — bounds payload and avoids leaking more than
 * the matched context), the sender, and the timestamp. Tombstoned bodies are
 * excluded upstream, so a hit's `snippet` is always real content.
 */
export interface MessageSearchHit {
  id: string;
  conversationId: string;
  snippet: string;
  sender: AuthorSummary;
  createdAt: string;
}

/**
 * Per-conversation metadata for grouping search hits in the inbox: the
 * counterpart (null for the official/welcome thread, which the client labels
 * with the org identity) and `isOfficial` so the client can render the right
 * name/avatar without a second round-trip.
 */
export interface MessageSearchConversationGroup {
  conversationId: string;
  otherParticipant: AuthorSummary | null;
  isOfficial: boolean;
}

/**
 * Response for `GET /messages/search`: the echoed (trimmed) `query`, the flat
 * `hits` newest-first, and the `conversations` metadata the client joins hits to
 * for grouped rendering. Permission-scoped and `clearedAt`-floored server-side.
 */
export interface MessageSearchResponse {
  query: string;
  hits: MessageSearchHit[];
  conversations: MessageSearchConversationGroup[];
}

/**
 * One starred-message row for the "Starred messages" view — the same jump-to
 * shape as a search hit (message + conversation ids, a body snippet, sender,
 * timestamp) plus `starredAt` (when the viewer bookmarked it), so the list can
 * order by bookmark recency. Scoped to the caller by construction.
 */
export interface StarredMessageHit extends MessageSearchHit {
  starredAt: string;
}

/**
 * Response for `GET /messages/starred`: the caller's starred messages
 * newest-star-first, plus the per-conversation grouping metadata (reused from
 * search) the client joins each hit to for a labelled, jump-to-able row.
 */
export interface StarredMessagesResponse {
  items: StarredMessageHit[];
  conversations: MessageSearchConversationGroup[];
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
