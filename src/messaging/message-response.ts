import type { CursorPage } from '../common/cursor-pagination';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import type { CropRect } from '../media-crops/crop-rect';
import { Profile } from '../users/entities/profile.entity';
import {
  ConversationMuteMode,
  ConversationRole,
} from './entities/conversation-participant.entity';
import {
  DocumentAttachment,
  GifAttachment,
  isDocumentAttachment,
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
  /** NULL once the author erased their account (ENG-243). */
  senderId: string | null;
  body: string;
  replyToId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  clientMessageId: string | null;
  forwarded: boolean;
  kind: MessageKind;
  systemEvent: SystemEvent | null;
  attachment: GifAttachment | DocumentAttachment | null;
}

/**
 * Resolves a stored attachment's storage key(s) through `toImageUrl` before it
 * ever reaches the client. For a `GifAttachment`: a no-op for a `kind:'gif'`
 * message (its `url`/`previewUrl` are already absolute `https://` provider
 * URLs — `toImageUrl` passes those through unchanged); for a `kind:'image'`
 * message it turns the private storage KEY the upload minted into a fetchable
 * `GET /files/<key>` URL, the same way every other image field in this app
 * resolves at read time. For a `DocumentAttachment` (`kind:'document'`) only
 * `url` exists to resolve — there is no `previewUrl`. `null` in → `null` out.
 */
export function resolveAttachment(
  attachment: GifAttachment | DocumentAttachment | null,
): GifAttachment | DocumentAttachment | null {
  if (!attachment) {
    return null;
  }
  if (isDocumentAttachment(attachment)) {
    const url = toImageUrl(attachment.url);
    // See the `GifAttachment` branch below for why a resolution failure blanks
    // the attachment entirely rather than serving a broken `url`.
    if (!url) {
      return null;
    }
    return { ...attachment, url };
  }
  const url = toImageUrl(attachment.url);
  const previewUrl = toImageUrl(attachment.previewUrl);
  // toImageUrl only returns null for a value that's neither a storage key nor
  // an absolute https URL — shouldn't happen for a value this service itself
  // validated on write (see `MessagingCoreService.postMessage`), but blanking
  // a message's attachment entirely (rather than sending a broken/`null` src)
  // is the safe failure mode if it ever does.
  if (!url || !previewUrl) {
    return null;
  }
  return { ...attachment, url, previewUrl };
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
  /** The member's own pronouns from their profile, else null. Ungated, the
   *  same as `ProfileCard.pronouns` (`profiles/profile-response.ts`): no
   *  privacy switch hides pronouns anywhere else, so a DM header does not
   *  invent one. Drives the conversation header's meta line. */
  pronouns: string | null;
  avatarUrl: string | null;
  /** True for the author of a message whose sender erased their account
   *  (ENG-243): `handle` is empty, `avatarUrl` null, and the client renders a
   *  localized "Former member" with a neutral avatar and no profile link.
   *  Optional so author summaries built outside messaging stay valid. */
  isFormerMember?: boolean;
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
  /** The quoted message this one replies to, resolved server-side. Null if not a reply.
   *  `kind` is the parent's own kind and is reported even for a deleted parent;
   *  `thumbnailUrl` (a gif/image parent's resolved `previewUrl`) and `fileName`
   *  (a document parent's) are null otherwise, and null whenever `deleted`. */
  replyTo: {
    id: string;
    snippet: string;
    senderName: string;
    /** True when the quoted message's author has erased their account
     *  (ENG-243). `senderName` then carries the English fallback and the
     *  client renders its own localized "Former member" label. */
    senderIsFormerMember: boolean;
    deleted: boolean;
    kind: 'user' | 'system' | 'gif' | 'image' | 'document';
    thumbnailUrl: string | null;
    fileName: string | null;
  } | null;
  /** `user` (an ordinary bubble), `system` (a rendered event pill), `gif` (a
   *  picked provider GIF), `image` (a member-uploaded photo), or `document`
   *  (a member-uploaded PDF/spreadsheet/text file, PRD-226). Present on every
   *  message; a DM's messages are all `user`, so the client's existing bubble
   *  path is unchanged. */
  kind: 'user' | 'system' | 'gif' | 'image' | 'document';
  /** Resolved system event for a `system` message, else null. Actor/target are
   *  resolved to DISPLAY NAMES server-side (the client only renders bilingual
   *  templates, never user ids); `actorHandle`/`targetHandle` are their public
   *  profile handles (slugs), not display names, carried alongside so a client
   *  that receives a broadcast copy of this event (no `actorIsMe`/`targetIsMe`,
   *  see below) can still tell "is this me" by comparing a handle against its
   *  own. `value` carries a scalar the event needs (e.g. a new group title). */
  systemEvent: {
    type: SystemEventType;
    actorName: string;
    targetName: string | null;
    /** The actor's profile handle (slug), or null if unresolved. Public, so
     *  safe on a broadcast copy that omits `actorIsMe`. */
    actorHandle: string | null;
    /** The target's profile handle (slug), or null when the event carries no
     *  target or it is unresolved. */
    targetHandle: string | null;
    value: string | null;
    /** Whether THIS viewer is the event's actor, computed server-side. Every
     *  pill whose copy names the actor needs a "you" variant ("You made Ana an
     *  admin" instead of "Cy made Ana an admin"), and the client must never
     *  guess this by comparing `actorName` to its own display name (two
     *  members can share one), except by comparing `actorHandle` for the
     *  broadcast copy that carries no flags at all (see below).
     *  OPTIONAL: only present when `buildSystemEvent` was given a `viewerId`.
     *  A broadcast copy fanned to every participant at once has no single
     *  viewer to compute this for, so it omits the field entirely rather than
     *  shipping a false `false`; that caller (`GroupsService`) instead lets
     *  each client derive "is this me" from `actorHandle`. */
    actorIsMe?: boolean;
    /** Whether THIS viewer is the event's target, computed server-side, same
     *  reasoning and same optionality as `actorIsMe` (e.g. "Cy added you" /
     *  "You are now the owner"). Always false (when present) when the event
     *  carries no target. */
    targetIsMe?: boolean;
  } | null;
  /** The media attachment for a `kind:'gif'`/`kind:'image'`
   *  (`url`/`previewUrl`/`width`/`height`/`provider`) or `kind:'document'`
   *  (`url`/`fileName`/`byteSize`/`contentType`/`provider`) message, else
   *  null. The client renders a gif/image inline and a document as a
   *  file-card bubble (name, format, size, a download link); `body` carries a
   *  "GIF"/"Photo"/"Document" text fallback so previews/notifications keep
   *  working. Every `url` here is always a resolved, fetchable URL (see
   *  `resolveAttachment`) — never a bare storage key. */
  attachment: GifAttachment | DocumentAttachment | null;
}

/**
 * One backward ("load older") page of `GET /conversations/:id/messages`:
 * newest-first `data` plus the shared cursor envelope. `pageInfo.nextCursor` is
 * the opaque cursor of the OLDEST message in `data` when `hasMore`, else null;
 * the client passes it back as `?cursor=` to fetch the page before it. The
 * forward reconcile path (`?after=`) is deliberately NOT wrapped and still
 * returns a bare `MessageResponse[]`.
 */
export type MessageHistoryPage = CursorPage<MessageResponse>;

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
  /** PRD-351: the real INSTANT this member last read (`markRead`'s server
   *  clock), distinct from `lastReadAt`'s watermark, see
   *  `ConversationParticipant.lastReadInstant`'s own doc. Null for a member
   *  who has never read, and withheld (null) under the same read-receipt
   *  privacy gate as `lastReadAt`. */
  lastReadInstant: string | null;
}

/**
 * ENG-253: the trimmed avatar-stack preview `ConversationResponse.
 * memberPreview` sends INSTEAD of the full `members` roster on an inbox list
 * row, enough to render group avatars, never a member's role or
 * read/delivered watermark, which the list never renders and which used to
 * ship on every row regardless. Populated on every `ConversationResponse`
 * (list AND single-conversation), where `members` itself is populated only on
 * the single-conversation read path (see `ConversationResponse.members`'s own
 * doc).
 */
export interface ConversationMemberPreview {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Resolves a stored `SystemEvent` (actor/target as user ids) into the
 * display-name shape the client renders. Names come from the batch-loaded
 * profiles so a later rename is always reflected; a missing profile falls back
 * to a generic "Member". `null` in -> `null` out (a `user` message).
 *
 * `viewerId` drives `actorIsMe`/`targetIsMe` (PRD-355/DES-227): every pill
 * whose copy names the actor or target needs a "you" variant, and only the
 * server can say who "you" is. Optional (default `undefined`) purely for
 * historic call sites that have not threaded a viewer through yet; a missing
 * viewer reads as "not me" for both, which is the safe default (never shows a
 * false "you").
 */
export function buildSystemEvent(
  event: SystemEvent | null,
  profileByUser: Map<string, Profile>,
  viewerId?: string,
): MessageResponse['systemEvent'] {
  if (!event) {
    return null;
  }
  const nameOf = (userId: string | undefined): string | null => {
    if (!userId) return null;
    const profile = profileByUser.get(userId);
    return profile ? requireAuthorSummary(profile).displayName : 'Member';
  };
  const handleOf = (userId: string | undefined): string | null => {
    if (!userId) return null;
    const profile = profileByUser.get(userId);
    return profile ? profile.slug : null;
  };
  return {
    type: event.type,
    actorName: nameOf(event.actorId) ?? 'Member',
    targetName: nameOf(event.targetId),
    actorHandle: handleOf(event.actorId),
    targetHandle: handleOf(event.targetId),
    value: event.value ?? null,
    // `actorIsMe`/`targetIsMe` are only meaningful for a per-viewer read (a
    // single caller's history/inbox page); omitted entirely (not `false`)
    // when no `viewerId` is threaded through, e.g. `GroupsService`'s
    // broadcast copy of a system event, which every participant receives
    // identically and so can compute no single "is this me" answer.
    ...(viewerId != null
      ? {
          actorIsMe: event.actorId === viewerId,
          targetIsMe: event.targetId === viewerId,
        }
      : {}),
  };
}

/** `Message.kind` (the entity enum) to the frontend-contract
 *  `MessageResponse.kind` string union. The one mapping shared by the
 *  inbox-preview and full-thread paths (`MessagingCoreService`) and by a reply
 *  quote's parent kind (`buildReplyTo`), so the three can't drift. */
export function messageKindToResponseKind(
  kind: MessageKind,
): MessageResponse['kind'] {
  switch (kind) {
    case MessageKind.System:
      return 'system';
    case MessageKind.Gif:
      return 'gif';
    case MessageKind.Image:
      return 'image';
    case MessageKind.Document:
      return 'document';
    default:
      return 'user';
  }
}

/**
 * Builds `MessageResponse.replyTo` for a single message from the batch-fetched
 * reply parents/sender profiles in `toMessageResponses`. `null` when the
 * message isn't a reply. Otherwise: `deleted` is true when the parent itself
 * has since been soft-deleted, is missing entirely (e.g. hard-removed by a
 * since-reverted migration), or is in `hiddenParentIds` (a moderator takedown
 * this viewer may not see). In every such case `snippet`, `thumbnailUrl` and
 * `fileName` are blanked rather than leaking withheld content, while `kind`
 * still reports what the parent was (`user` for a missing parent, which has
 * nothing left to report). `senderName` falls back to "Someone" when the
 * parent's sender profile can't be resolved.
 *
 * `thumbnailUrl` goes through `resolveAttachment`, the SAME resolver the
 * parent's own `attachment.previewUrl` uses, so a quote's thumbnail is always
 * as fetchable as the bubble it quotes.
 */
export function buildReplyTo(
  replyToId: string | null,
  parentById: Map<
    string,
    Pick<
      Message,
      'id' | 'body' | 'senderId' | 'deletedAt' | 'kind' | 'attachment'
    >
  >,
  profileByUser: Map<string, Profile>,
  hiddenParentIds: ReadonlySet<string> = new Set(),
): MessageResponse['replyTo'] {
  if (!replyToId) {
    return null;
  }
  const parent = parentById.get(replyToId);
  const deleted = Boolean(
    !parent || parent.deletedAt || hiddenParentIds.has(replyToId),
  );
  // ENG-243: a parent whose author erased their account has a NULL sender and
  // is quoted as a former member, never as the generic "Someone".
  const isParentSenderFormerMember = Boolean(
    parent && parent.senderId === null,
  );
  const parentSenderProfile =
    parent && parent.senderId !== null
      ? profileByUser.get(parent.senderId)
      : undefined;
  const visibleAttachment =
    parent && !deleted ? resolveAttachment(parent.attachment) : null;
  let thumbnailUrl: string | null = null;
  let fileName: string | null = null;
  if (visibleAttachment && isDocumentAttachment(visibleAttachment)) {
    fileName =
      parent?.kind === MessageKind.Document ? visibleAttachment.fileName : null;
  } else if (visibleAttachment) {
    thumbnailUrl =
      parent?.kind === MessageKind.Gif || parent?.kind === MessageKind.Image
        ? visibleAttachment.previewUrl
        : null;
  }
  return {
    id: replyToId,
    snippet: parent && !deleted ? parent.body.slice(0, 120) : '',
    senderName: isParentSenderFormerMember
      ? FORMER_MEMBER_DISPLAY_NAME
      : parentSenderProfile
        ? `${parentSenderProfile.firstName} ${parentSenderProfile.lastName}`.trim() ||
          'Someone'
        : 'Someone',
    senderIsFormerMember: isParentSenderFormerMember,
    deleted,
    kind: parent ? messageKindToResponseKind(parent.kind) : 'user',
    thumbnailUrl,
    fileName,
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
  /** PRD-351: the OTHER participant's real read INSTANT (ISO), distinct from
   *  the watermark above, see `ConversationParticipant.lastReadInstant`'s own
   *  doc. Drives the message info sheet's "Read" row showing an actual time
   *  instead of no time at all. Null under the exact same conditions as
   *  `otherLastReadAt` (official/group threads, a counterpart who has never
   *  read, or either side withholding read-receipt sharing, PRD-364). */
  otherLastReadInstant: string | null;
  /** THIS caller's own read watermark (ISO), for placing the "New messages"
   *  divider on open: every message after it that the caller did not send is
   *  unread. Present for DMs, official and group threads alike. Null when the
   *  caller has never read the thread. */
  myLastReadAt: string | null;
  /** The OTHER participant's delivered watermark (ISO), for the "double check".
   *  Mirrors `otherLastReadAt` one rung down. Null for official/group threads or
   *  a counterpart whose device hasn't acked anything yet. */
  otherDeliveredAt: string | null;
  /** The other participant's user id — used only client-side to correlate
   *  presence (`presence` events key by userId). Null for official/group. */
  otherParticipantId: string | null;
  /**
   * True for a DIRECT, non-official DM where THIS caller's next ordinary send
   * would 403 right now (PRD-220, refined by PRD-340). Equivalent to
   * `replyGate !== "open"` below. Originally meant "the two aren't accepted
   * connections"; a cold enquiry / message request now opens a thread for the
   * member who did NOT start it, on their first reply (see `replyGate`), so
   * this can be false even between two members who never connected. Kept for
   * existing callers (e.g. `Composer.tsx`'s gate). Always false for
   * group/official threads, where the gate does not apply.
   */
  replyRequiresConnection: boolean;
  /**
   * PRD-340: the one-tap-reply state of a DIRECT, non-official DM, from THIS
   * caller's point of view.
   *  - `"open"`: an ordinary send will succeed (accepted connections, or a
   *    non-connected thread this caller may reply into, or one already opened).
   *  - `"awaitingTheirReply"`: this caller started a non-connected thread and
   *    is waiting for the other side's first reply before they may send again.
   *  - `"needsConnection"`: neither side may send yet (the platform's original
   *    rule; no explicit initiator/opened state exists for this thread).
   * Optional (absent) for a group/official thread, where the gate never
   * applies and callers should treat a missing value as `"open"`.
   * `replyRequiresConnection` above is equivalent to `replyGate !== "open"`
   * and is kept for existing callers; new UI should read this field, which
   * carries the nuance `ComposerConnectionNotice` needs to tell "they haven't
   * answered yet" apart from "you two aren't connected".
   */
  replyGate?: 'open' | 'awaitingTheirReply' | 'needsConnection';
  /** DES-225: ISO timestamp this caller and a DIRECT, non-official DM's
   *  counterpart became accepted connections (`ConnectionsService.
   *  acceptedSinceByCounterpart`). Null for groups, official threads, and a DM
   *  between members who aren't (or are no longer) accepted connections.
   *  Drives the header's "Connected since" meta line. */
  connectedSince: string | null;
  /** `direct` (1:1 DM / official) or `group` (member-created, titled,
   *  multi-participant). The client branches its header/inbox/attribution on
   *  this; DMs stay `direct` and render exactly as before. */
  kind: 'direct' | 'group';
  /** Group name (null for DMs — their name is the counterpart's). */
  title: string | null;
  /** Group avatar URL (null for DMs — the counterpart's avatar is used). */
  avatarUrl: string | null;
  /** Crop rect for `avatarUrl`, when a group admin reframed it. */
  avatarCrop?: CropRect;
  /** Active (not-left) member count for a group; 0 for DMs. Drives the header
   *  subtitle ("5 members"). */
  memberCount: number;
  /**
   * ENG-253: the FULL group member roster (role + per-member read/delivered
   * watermark), empty for DMs, UNCHANGED from before ENG-253, but no longer
   * populated on an inbox LIST row. It is only ever non-empty on the
   * single-conversation read path (`GET /conversations/:id`,
   * `ConversationsService.getConversation`) and on the pre-existing
   * group-mutation responses (create/add/remove/role-change/etc., built by
   * `GroupsService`/`GroupInvitesService`, unaffected by ENG-253). Every
   * caller that actually needs "Seen by N" or a role badge already reads the
   * thread's own full detail rather than the inbox list. An inbox LIST row
   * gets `[]` here and reads `memberPreview` instead for its avatar stack.
   * Read-only in Phase 1 (role badges); Phase 2 adds add/remove/promote.
   */
  members: ConversationMemberSummary[];
  /** ENG-253: the lightweight avatar-stack preview, populated for a group on
   *  EVERY `ConversationResponse` (list and single-conversation alike), see
   *  `ConversationMemberPreview`'s own doc. Empty for DMs. */
  memberPreview: ConversationMemberPreview[];
  // Backend extras beyond the frontend contract, which ignores unknown fields.
  // `isOfficial` distinguishes the org/welcome thread `type: 'group'` covers
  // coarsely; `muted` is this caller's per-conversation preference and is only
  // present where a participant row was already loaded (i.e. the list path).
  isOfficial?: boolean;
  muted?: boolean;
  /** When a TIMED mute (PRD-349: 8 hours / 1 week) expires, present only
   *  where a participant row was loaded (like `muted`). Null while `muted`
   *  is false, and ALSO null while `muted` is true but the caller chose
   *  "Always" (there is no separate forever sentinel, see
   *  `ConversationParticipant.mutedUntil`'s own doc). A past value has
   *  already been lazily cleared server-side by the time this is read. */
  mutedUntil?: string | null;
  /** PRD-349: the caller's own mute MODE (`'all'` \| `'mentionsOnly'`), a
   *  second axis independent of `muted`/`mutedUntil` above (see
   *  `ConversationParticipant.muteMode`'s own doc for exactly how the two
   *  interact). Present only where a participant row was loaded (like
   *  `muted`). `'mentionsOnly'` means this caller never gets the plain "new
   *  message" push (an `@`-mention still reaches them); it says nothing about
   *  whether `muted`/`mutedUntil` are also set, so the client renders a
   *  distinct "Mentions only" state rather than collapsing it into "Muted". */
  muteMode?: ConversationMuteMode;
  /** PRD-348: whether an UNREAD message in this thread `@`-mentions the
   *  caller, computed from their own read watermark
   *  (`MessagingCoreService.hasUnreadMentionByConversation`), present only
   *  where a participant row was loaded (like `muted`). */
  hasUnreadMention?: boolean;
  // `pinnedAt`/`favorite` are this caller's per-conversation preferences (like
  // `muted`), present only where a participant row was loaded (the list path).
  // `pinnedAt` is the ISO instant the caller pinned the thread (null = unpinned;
  // most-recent first sorts pins); `favorite` is whether the caller favorited it.
  pinnedAt?: string | null;
  favorite?: boolean;
  /** When THIS caller archived the thread out of their main inbox (like
   *  `pinnedAt`), present only where a participant row was loaded (the list
   *  path). NULL = not archived. Auto-cleared server-side the instant a new
   *  message lands — see `ConversationParticipant.archivedAt`'s own doc. */
  archivedAt?: string | null;
  /** When THIS caller explicitly marked the thread unread from the inbox row
   *  menu (PRD-225), present only where a participant row was loaded (the
   *  list path). NULL = not manually marked unread. Independent of
   *  `unreadCount` — a genuinely-read thread can still carry this flag until
   *  the caller re-opens it (`ConversationParticipant.markedUnreadAt`'s own
   *  doc). The client ORs it with `unreadCount > 0` to decide the row's
   *  unread state. */
  markedUnreadAt?: string | null;
  /**
   * THIS caller's own unsent composer text for the thread, synced from
   * whichever device last wrote it (present only where a participant row was
   * loaded). The client's `features/messages/drafts.ts` localStorage copy is
   * the instant local layer; this is the cross-device layer it
   * debounce-syncs to. NULL = no stored draft.
   *
   * ENG-253: no longer sent on an inbox LIST row. The caller's draft can run
   * to 5000 characters (`UpdateConversationDto.draft`) and the list only ever
   * rendered a short preview, never the full text. Present in full ONLY on
   * the single-conversation read path (`getConversation`) and the
   * pre-existing group-mutation responses, unaffected by ENG-253, that
   * already carried a participant row. A LIST row instead gets
   * `draftPreview`/`hasDraft` below, which ARE present everywhere (list and
   * single-conversation alike).
   */
  draft?: string | null;
  /** ENG-253: the first 120 characters of `draft`, present wherever a
   *  participant row was loaded (list AND single-conversation), enough for
   *  the inbox row's own draft preview without shipping the full body on
   *  every refetch. Null exactly when `hasDraft` is false. */
  draftPreview?: string | null;
  /** ENG-253: whether a draft is currently stored at all, present wherever a
   *  participant row was loaded (like `draftPreview`). Lets the client show
   *  the "Draft" label/badge without inspecting `draftPreview`'s length. */
  hasDraft?: boolean;
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
  /** PRD-358: the group's about text (max 500), member-authored. Null for DMs
   *  and for a group that has never set one. */
  description: string | null;
  /** PRD-357: ISO timestamp the group was ended (by its owner, or by the last
   *  leaver when nobody remained to inherit it), else null. Once set the group
   *  is read-only: every write route refuses with `GROUP_DISSOLVED`. Always
   *  null for DMs, which are never dissolved. */
  dissolvedAt: string | null;
  /**
   * DES-227: why THIS caller can no longer act as a member here, or null while
   * they still can. `'left'` (voluntary), `'removed'` (an owner/admin acted),
   * or `'dissolved'` (the group itself ended, independent of how this caller's
   * own membership ended) drive the severed-notice copy ("You left this
   * group" / "You were removed from this group" / "This group has ended").
   * Always null for a DM and for an active group member.
   */
  leftReason: GroupLeftReason;
  /** PRD-358: the group's active join-by-link token, surfaced ONLY to an
   *  owner/admin of an active (not dissolved) group; null for every other
   *  caller, for a group with no active link, and always for DMs. Rotating or
   *  disabling the link changes this value; the client renders it as a
   *  copyable/shareable URL, never a QR code (PRD-359 deferred). */
  inviteToken: string | null;
  /** SERVER-AUTHORITATIVE: whether THIS caller may create/rotate/disable the
   *  invite link (`POST`/`DELETE :id/invite-link`). True only for an
   *  owner/admin of an active, non-dissolved group. Optional/absent for DMs,
   *  matching the other capability flags above. */
  canManageInviteLink?: boolean;
  /** SERVER-AUTHORITATIVE: whether THIS caller may transfer ownership
   *  (`POST :id/owner`). True only for the OWNER of an active, non-dissolved
   *  group (an admin cannot). Optional/absent for DMs. */
  canTransferOwnership?: boolean;
  /** SERVER-AUTHORITATIVE: whether THIS caller may dissolve the group
   *  (`POST :id/dissolve`). True only for the OWNER of an active,
   *  non-dissolved group. Optional/absent for DMs. */
  canDissolve?: boolean;
  /** PRD-353: invites this caller may manage, i.e. pending `group_invites`
   *  rows on THIS group, for an owner/admin to see who has been asked and not
   *  yet answered. Empty for every other caller and always for DMs. */
  pendingInvites: PendingGroupInvite[];
}

/**
 * ENG-253: one cursor-paginated page of `GET /conversations` (the inbox),
 * mirroring `MessageHistoryPage`'s own envelope shape exactly. `data` is
 * this page's rows, most-recently-active first; `pageInfo.nextCursor` is the
 * opaque cursor of the OLDEST-activity row in `data` when `pageInfo.hasMore`,
 * else null, and the client passes it back as `?cursor=` for the next page.
 * Replaces the previous bare `ConversationResponse[]` response.
 */
export type ConversationListPage = CursorPage<ConversationResponse>;

/**
 * DES-227: why a caller who can no longer act as a member of a group left the
 * roster, or `null` while they still can (or for a DM, which never severs this
 * way). See `ConversationResponse.leftReason`'s own doc for what drives the
 * client copy.
 */
export type GroupLeftReason = 'left' | 'removed' | 'dissolved' | null;

/**
 * One row of `ConversationResponse.pendingInvites`: an owner/admin's view of a
 * single outstanding invite on their group, enough to render "Ana invited Cy,
 * 2 days ago" with a Revoke action (`DELETE :id/invites/:inviteId`).
 */
export interface PendingGroupInvite {
  /** The `group_invites` row id, the target of the revoke call. */
  id: string;
  /** The invited member, in the same shape a roster row uses. */
  user: Pick<ConversationMemberSummary, 'id' | 'handle' | 'name' | 'avatarUrl'>;
  /** ISO timestamp the invite was sent. */
  createdAt: string;
}

/**
 * Computes {@link GroupLeftReason} from the three facts that determine it, so
 * every `ConversationResponse` builder derives the SAME answer rather than
 * each hand-rolling the precedence. Order matters: a caller whose `leftAt` was
 * set by the group's own dissolve (both timestamps present) reads as
 * `'dissolved'` even though their row also carries a `leftAt`, because
 * "the group ended" is the truer story than "I left" when the two coincide.
 * `removedAt` outranks a bare `leftAt` next (a removal always also sets
 * `leftAt`, so the two are never used to distinguish removal from a voluntary
 * leave). `null` when the caller is still active.
 *
 * Reads `removedAt`, NOT `removedBy`: `removedBy` carries an `ON DELETE SET
 * NULL` foreign key to the remover's own account, so it goes quietly NULL
 * the moment that account is deleted, and a removal that keyed off
 * `removedBy` alone would misread back as `'left'` from that point on.
 * `removedAt` carries no such FK (see its column doc for the full contract).
 */
export function computeGroupLeftReason(params: {
  leftAt: Date | null | undefined;
  removedAt: Date | null | undefined;
  dissolvedAt: Date | null | undefined;
}): GroupLeftReason {
  const { leftAt, removedAt, dissolvedAt } = params;
  if (dissolvedAt && leftAt) return 'dissolved';
  if (removedAt) return 'removed';
  if (leftAt) return 'left';
  return null;
}

/**
 * One row of `GET /group-invites`: an invite addressed to the CALLER,
 * pending their accept/decline. Enough to render "Ana invited you to Trans
 * Book Club" with the two actions (`POST group-invites/:inviteId/accept`\|
 * `decline`) and a jump to the group's identity, without the caller being a
 * participant yet (so this carries the group's own title/avatar/count rather
 * than reusing `ConversationResponse`, which requires membership to build).
 */
export interface GroupInviteSummary {
  /** The `group_invites` row id, the target of the accept/decline call. */
  id: string;
  conversationId: string;
  /** The group's name, as it will read once the caller joins. */
  title: string | null;
  avatarUrl: string | null;
  /** Active (not-left) member count at the time of the read, so the caller can
   *  judge the group's size before deciding. */
  memberCount: number;
  /** Who sent the invite. */
  inviter: AuthorSummary;
  /** ISO timestamp the invite was sent. */
  createdAt: string;
}

/**
 * The unauthenticated-membership preview `GET join/:token` returns before a
 * caller decides whether to `POST join/:token`. Deliberately narrow: no
 * roster, no message history, no invite token itself, just enough to answer
 * "is this the right group, and am I already in it".
 */
export interface GroupJoinPreview {
  conversationId: string;
  title: string | null;
  avatarUrl: string | null;
  description: string | null;
  /** Active (not-left) member count. */
  memberCount: number;
  /** Whether the caller is ALREADY an active member, so the client can offer
   *  "Open group" instead of "Join" without a second round trip. */
  isMember: boolean;
}

/**
 * One cross-conversation message-search hit (see `MessagingService.searchMessages`).
 * Carries just enough to render a result row and navigate to it: the message and
 * conversation ids for the jump, a server-windowed `snippet` around the match
 * (the full body is never returned — bounds payload and avoids leaking more than
 * the matched context), the sender, and the timestamp. Tombstoned bodies are
 * excluded upstream, so a hit's `snippet` is always real content. `kind` and
 * `attachment` ride the same `Message` row the search/starred queries already
 * select (no extra query) and mirror `MessageResponse`'s own fields exactly,
 * `attachment` goes through the same `resolveAttachment` resolver so a hit's
 * thumbnail/file name is always a fetchable URL, never a bare storage key.
 */
export interface MessageSearchHit {
  id: string;
  conversationId: string;
  snippet: string;
  sender: AuthorSummary;
  createdAt: string;
  /** `user`/`system`/`gif`/`image`/`document`, mirrors `MessageResponse.kind`. */
  kind: 'user' | 'system' | 'gif' | 'image' | 'document';
  /** The resolved media attachment, mirroring `MessageResponse.attachment`;
   *  null for a plain-text hit. */
  attachment: GifAttachment | DocumentAttachment | null;
}

/**
 * Per-conversation metadata for grouping search hits in the inbox: the
 * counterpart (null for the official/welcome thread OR a group, which the
 * client labels with the org identity / the group's own identity instead),
 * `isOfficial`, and the group identity fields (`kind`/`title`/`avatarUrl`,
 * mirroring `ConversationResponse`) so a hit inside a GROUP conversation
 * renders under the group's own name/avatar rather than an arbitrary
 * member's, the client can render the right name/avatar without a second
 * round-trip either way.
 */
export interface MessageSearchConversationGroup {
  conversationId: string;
  otherParticipant: AuthorSummary | null;
  isOfficial: boolean;
  /** `direct` (DM/official) or `group`, mirrors `ConversationResponse.kind`. */
  kind: 'direct' | 'group';
  /** Group name, null for a DM/official thread, mirrors `ConversationResponse.title`. */
  title: string | null;
  /** Group avatar URL, null for a DM/official thread, mirrors `ConversationResponse.avatarUrl`. */
  avatarUrl: string | null;
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
 *
 * PRD-374: keyset-paginated. `nextCursor` is the opaque cursor for the next
 * older page, or null when this page reached the end; `hasMore` mirrors it as
 * a plain boolean so the client doesn't need to null-check the cursor just to
 * decide whether to show a "Load more" affordance.
 */
export interface StarredMessagesResponse {
  items: StarredMessageHit[];
  conversations: MessageSearchConversationGroup[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One member's reaction on a message, for the "who reacted" sheet (PRD-352).
 *  Mirrors the frontend's `MessageReactor` in `contracts.ts`. */
export interface MessageReactor {
  key: MessageReactionKey;
  member: AuthorSummary;
  /** The caller's own reaction, which the sheet offers to remove. */
  isMine: boolean;
  /** When the reaction was made. Always null today: `message_reactions` has no
   *  timestamp column, and adding one is a migration of its own. */
  reactedAt: string | null;
}

/** Response for `GET /conversations/:id/messages/:messageId/reactions`. */
export interface MessageReactorsResponse {
  reactors: MessageReactor[];
}

const UNKNOWN_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Member',
  pronouns: null,
  avatarUrl: null,
  isFormerMember: false,
};

/** English fallback for an erased author's name. The client renders its own
 *  localized label off `isFormerMember`; this string is only what a consumer
 *  that ignores the flag (push copy, logs) would show. */
export const FORMER_MEMBER_DISPLAY_NAME = 'Former member';

/**
 * The author of a message whose sender erased their account (ENG-243): no
 * handle (so no profile link), no pronouns, no avatar, and the flag the client
 * keys its neutral rendering on.
 */
export const FORMER_MEMBER_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: FORMER_MEMBER_DISPLAY_NAME,
  pronouns: null,
  avatarUrl: null,
  isFormerMember: true,
};

/**
 * The one spelling of "who wrote this message" for every messaging read path.
 * A NULL `senderId` is an erased member and maps to {@link FORMER_MEMBER_AUTHOR};
 * a live sender resolves through `profileByUser` exactly as
 * `requireAuthorSummary` always did.
 */
export function senderAuthorSummary(
  senderId: string | null,
  profileByUser: ReadonlyMap<string, Profile>,
): AuthorSummary {
  if (senderId === null) {
    return FORMER_MEMBER_AUTHOR;
  }
  return requireAuthorSummary(profileByUser.get(senderId));
}

/** The non-null sender ids of a batch, de-duplicated, for one profile lookup. */
export function presentSenderIds(
  messages: ReadonlyArray<{ senderId: string | null }>,
): string[] {
  const senderIds = new Set<string>();
  for (const message of messages) {
    if (message.senderId !== null) {
      senderIds.add(message.senderId);
    }
  }
  return [...senderIds];
}

function authorSummaryFrom(profile: Profile): AuthorSummary {
  return {
    handle: profile.slug,
    displayName: `${profile.firstName} ${profile.lastName}`.trim(),
    // Every messaging caller loads the full `Profile` entity (no `select`),
    // so the column is always present here.
    pronouns: profile.pronouns,
    // The `photoVisible` gate, through the one shared spelling. A DM thread is
    // not an exemption from "Show your photo": the member hid their face from
    // the feed and the forum with the same switch, and a conversation they may
    // have opened before things went wrong is the last place it should persist.
    avatarUrl: toVisibleAvatarUrl(profile),
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
