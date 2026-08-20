import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, QueryFailedError, Repository } from 'typeorm';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { GifAttachment, Message, MessageKind } from './entities/message.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { storageKeyFromImageUrl } from '../common/image-url';
import { parseStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  buildReplyTo,
  buildSystemEvent,
  ConversationMemberSummary,
  MessageResponse,
  MessageView,
  ReactionSummary,
  requireAuthorSummary,
  resolveAttachment,
  toMessageReactionSummaries,
  toMessageView,
} from './message-response';
import { EDIT_WINDOW_MS } from './messaging.constants';
import { MESSAGE_CREATED, MessageCreatedEvent } from './messaging.events';

/** `Message.kind` (the entity enum) → the frontend-contract `MessageResponse.kind`
 *  string union. Shared by `buildLastMessagePreview` and `toMessageResponses` so
 *  the mapping can't drift between the inbox-preview and full-thread paths. */
function messageKindToResponseKind(
  kind: MessageKind,
): MessageResponse['kind'] {
  switch (kind) {
    case MessageKind.System:
      return 'system';
    case MessageKind.Gif:
      return 'gif';
    case MessageKind.Image:
      return 'image';
    default:
      return 'user';
  }
}

/**
 * The fields needed to build a `MessageResponse`. Structural, so both a
 * persisted `Message` row and the internal `MessageView` satisfy it.
 */
export type MessageLike = Pick<
  Message,
  | 'id'
  | 'conversationId'
  | 'senderId'
  | 'body'
  | 'replyToId'
  | 'createdAt'
  | 'editedAt'
  | 'deletedAt'
  | 'clientMessageId'
  | 'forwarded'
  | 'kind'
  | 'systemEvent'
  | 'attachment'
>;

/**
 * Cross-cutting read/write helpers shared by `ConversationsService`,
 * `MessagesService`, `MessageAnnotationsService`, `GroupsService`, and
 * `MessageRequestsService` — extracted from the original god `MessagingService`
 * so this logic exists in exactly ONE place rather than being duplicated
 * per-concern.
 *
 * **The `clearedAt` floor lives here, singularly, via `requireParticipant`.**
 * Every read path across the five split services obtains a caller's
 * per-conversation `clearedAt` watermark through this one method — never a
 * re-derived copy — so "delete for me" semantics can't drift between
 * concerns. `toMessageResponses` (also centralized here) is the other
 * clearedAt-adjacent surface: it hydrates the frontend-contract
 * `MessageResponse` for any page of messages, reused by every concern that
 * returns a `MessageResponse[]`.
 */
@Injectable()
export class MessagingCoreService {
  // A message is reported (and taken down) under the `message` subject code,
  // keyed by the message uuid — mirrors `ReportSubjectType.Message`.
  private static readonly MESSAGE_SUBJECT_TYPE = 'message';

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(MessageReaction)
    private readonly reactions: Repository<MessageReaction>,
    @InjectRepository(ConversationPinnedMessage)
    private readonly pins: Repository<ConversationPinnedMessage>,
    @InjectRepository(MessageStar)
    private readonly stars: Repository<MessageStar>,
    // Read-only: the shared moderation-state table. A `hide_content` /
    // `remove_content` takedown on a `message` subject (keyed by the message
    // uuid) lands here, and `toMessageResponses` reads it to tombstone the
    // message in the thread — the messaging mirror of forum/community's
    // takedown read-enforcement. Injected as the repository (not the service)
    // because the thread needs the takedown TIMESTAMP for `deletedAt`, which
    // the service's boolean `ContentModerationState` doesn't carry.
    @InjectRepository(ContentModeration)
    private readonly moderationStates: Repository<ContentModeration>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly usersService: UsersService,
  ) {}

  /**
   * THE single source of a caller's participant row (and, on it, their
   * `clearedAt` "delete for me" floor) for a conversation. Every read/write
   * path across every split messaging service goes through this one method —
   * never a locally re-implemented lookup — so the floor can never diverge
   * between concerns.
   */
  async requireParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipant> {
    const part = await this.participants.findOne({
      where: { conversationId, userId },
    });
    if (!part) {
      throw new ForbiddenException('You are not a participant');
    }
    return part;
  }

  /**
   * A `NOT EXISTS` SQL fragment (message alias `m`) that is TRUE only when the
   * message carries no moderator takedown (neither hidden nor removed). Shared
   * by the message-counting/preview query builders so a taken-down message is
   * uniformly excluded. The caller must bind the `messageSubjectType` parameter
   * (`.setParameter('messageSubjectType', MESSAGE_SUBJECT_TYPE)`); it isn't
   * bound here so the fragment can be composed into any builder. `subject_id`
   * is varchar while `m.id` is uuid, hence the `::text` cast.
   */
  private notModeratedPredicate(): string {
    return `NOT EXISTS (
      SELECT 1 FROM "content_moderation" "cm"
      WHERE "cm"."subject_type" = :messageSubjectType
        AND "cm"."subject_id" = m.id::text
        AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
    )`;
  }

  /** Newest non-deleted message per conversation, in one DISTINCT ON pass. */
  async lastMessagesByConversation(
    convoIds: string[],
  ): Promise<Map<string, Message>> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .distinctOn(['m.conversation_id'])
      .where('m.conversation_id IN (:...convoIds)', { convoIds })
      // A moderator-taken-down message (hidden OR removed) is skipped as a
      // preview candidate too, so the inbox falls back to the newest CLEAN
      // message rather than leaking a withheld body — the preview never passes
      // through `toMessageResponses`, so the filter has to live here.
      .andWhere(this.notModeratedPredicate())
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      // DISTINCT ON must lead its ORDER BY with the distinct column; the
      // (created_at DESC, id DESC) tail then selects the newest row per
      // conversation deterministically. Backed by the composite index
      // messages (conversation_id, created_at DESC). Soft-deleted rows are
      // excluded automatically by the @DeleteDateColumn.
      .orderBy('m.conversation_id', 'ASC')
      .addOrderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .getMany();
    return new Map(rows.map((m) => [m.conversationId, m]));
  }

  /** This user's unread count per conversation, in one grouped query. */
  async unreadCountsByConversation(
    convoIds: string[],
    userId: string,
  ): Promise<Map<string, number>> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.conversation_id', 'conversationId')
      .addSelect('COUNT(*)', 'count')
      // Join THIS user's participant row to read their per-conversation
      // lastReadAt watermark in the same pass.
      .innerJoin(
        ConversationParticipant,
        'p',
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        { userId },
      )
      .where('m.conversation_id IN (:...convoIds)', { convoIds })
      .andWhere('m.sender_id != :userId', { userId })
      .andWhere('(p.last_read_at IS NULL OR m.created_at > p.last_read_at)')
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // A moderator-taken-down message never counts toward unread — the viewer
      // can no longer see it, so it must not drive a badge.
      .andWhere(this.notModeratedPredicate())
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string; count: string }>();
    return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
  }

  /**
   * How many of this user's conversations have at least one unread message —
   * the single number behind the nav DM badge (`GET /conversations/unread-count`),
   * so the badge never has to pull the whole inbox on every route. Uses the exact
   * per-conversation unread rules as `unreadCountsByConversation` above (exclude
   * the user's own messages; honour each thread's `last_read_at` and `cleared_at`
   * watermarks; soft-deleted messages are dropped by the `@DeleteDateColumn`),
   * but collapses them to one `COUNT(DISTINCT conversation)` — matching the
   * frontend demo badge, which counts unread *conversations*, not messages.
   */
  async unreadConversationCount(userId: string): Promise<number> {
    const raw = await this.messages
      .createQueryBuilder('m')
      .select('COUNT(DISTINCT m.conversation_id)', 'count')
      // Join THIS user's participant row for its lastReadAt / clearedAt
      // watermarks, exactly as unreadCountsByConversation does.
      .innerJoin(
        ConversationParticipant,
        'p',
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        { userId },
      )
      .where('m.sender_id != :userId', { userId })
      .andWhere('(p.last_read_at IS NULL OR m.created_at > p.last_read_at)')
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // A moderator-taken-down message never counts toward the unread badge.
      .andWhere(this.notModeratedPredicate())
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      .getRawOne<{ count: string }>();
    return Number(raw?.count ?? 0);
  }

  /**
   * Reaction summaries (per-key count + `mine`) for a batch of messages —
   * shared by the "last message" preview built inline by `ConversationsService`
   * and by `toMessageResponses`, so all callers surface the same shape without
   * a per-message query.
   */
  async reactionSummariesByMessage(
    messageIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    if (!messageIds.length) {
      return new Map();
    }
    const reactionRows = await this.reactions.find({
      where: { messageId: In(messageIds) },
    });
    const rowsByMessage = new Map<string, MessageReaction[]>();
    for (const reaction of reactionRows) {
      const list = rowsByMessage.get(reaction.messageId);
      if (list) {
        list.push(reaction);
      } else {
        rowsByMessage.set(reaction.messageId, [reaction]);
      }
    }
    const summariesByMessage = new Map<string, ReactionSummary[]>();
    for (const messageId of messageIds) {
      summariesByMessage.set(
        messageId,
        toMessageReactionSummaries(
          rowsByMessage.get(messageId) ?? [],
          viewerId,
        ),
      );
    }
    return summariesByMessage;
  }

  /**
   * Builds the `lastMessage` inbox-preview `MessageResponse` shared by
   * `ConversationsService.listConversations` and `toConversationResponse`/
   * `toGroupConversationResponse`. Previews carry no delivery/pin/star/reply
   * resolution (only the thread view does), but DO carry `kind`/`systemEvent`
   * so the inbox can render a system last message ("Ana created the group") as
   * its own line rather than a member-attributed bubble.
   */
  buildLastMessagePreview(
    message: Message,
    conversationId: string,
    profileByUser: Map<string, Profile>,
    reactions: ReactionSummary[],
  ): MessageResponse {
    const isSystem = message.kind === MessageKind.System;
    return {
      id: message.id,
      conversationId,
      body: message.body,
      sender: requireAuthorSummary(profileByUser.get(message.senderId)),
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt ? message.editedAt.toISOString() : null,
      reactions,
      // `lastMessagesByConversation` never returns a soft-deleted row.
      deletedAt: null,
      deliveredAt: null,
      clientMessageId: message.clientMessageId,
      forwarded: message.forwarded,
      pinnedAt: null,
      starred: false,
      canPin: false,
      // The inbox preview is never actionable (no long-press overlay renders
      // against it) — false across the board, mirroring `canPin` above.
      canEdit: false,
      canDelete: false,
      canReport: false,
      replyTo: null,
      kind: messageKindToResponseKind(message.kind),
      attachment: resolveAttachment(message.attachment),
      systemEvent: isSystem
        ? buildSystemEvent(message.systemEvent, profileByUser)
        : null,
    };
  }

  /**
   * The active (not-left) roster of a group thread, as `ConversationMemberSummary`
   * rows — owner first, then admins, then members, each alphabetical-stable by
   * insertion. A left participant is excluded from the roster and the count (they
   * keep read access but are no longer "in" the group). Profiles come from the
   * pre-batched map; a missing one falls back to the generic placeholder name.
   */
  buildMemberSummaries(
    participants: ConversationParticipant[],
    profileByUser: Map<string, Profile>,
  ): ConversationMemberSummary[] {
    const rank: Record<ConversationRole, number> = {
      [ConversationRole.Owner]: 0,
      [ConversationRole.Admin]: 1,
      [ConversationRole.Member]: 2,
    };
    return participants
      .filter((participant) => participant.leftAt == null)
      .map((participant) => {
        const summary = requireAuthorSummary(
          profileByUser.get(participant.userId),
        );
        return {
          id: participant.userId,
          handle: summary.handle,
          name: summary.displayName,
          avatarUrl: summary.avatarUrl,
          role: participant.role,
          // Per-member watermarks for group "Seen by N" — the client compares
          // each member's read watermark against a message's createdAt without
          // an N+1 per-message receipts endpoint.
          lastReadAt: participant.lastReadAt?.toISOString() ?? null,
          deliveredAt: participant.deliveredAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => rank[a.role] - rank[b.role]);
  }

  /**
   * SERVER-AUTHORITATIVE group capability flags for a caller, from their role and
   * whether they've left. `owner` may do everything (incl. manage roles); `admin`
   * may add/remove members + rename but NOT manage roles; `member` (and any left
   * participant) may do none. Surfaced on the group DTO so the client can gate its
   * UI, but every mutation independently re-checks the role via `requireGroupRole`
   * — these flags are a convenience, never the authority.
   */
  groupCapabilities(
    role: ConversationRole | undefined,
    hasLeft: boolean,
  ): {
    myRole: ConversationRole | null;
    canAddMembers: boolean;
    canRemoveMembers: boolean;
    canRename: boolean;
    canManageRoles: boolean;
  } {
    const isOwner = !hasLeft && role === ConversationRole.Owner;
    const isAdmin = !hasLeft && role === ConversationRole.Admin;
    const manages = isOwner || isAdmin;
    return {
      myRole: role ?? null,
      canAddMembers: manages,
      canRemoveMembers: manages,
      canRename: manages,
      canManageRoles: isOwner,
    };
  }

  /**
   * Hydrates sender profiles and reactions onto a page of messages in batched
   * queries and maps to the frontend-contract `MessageResponse`. `sender` is
   * non-nullable there — the frontend adapter reads `sender.displayName`
   * unguarded — so this goes through `requireAuthorSummary`, which supplies a
   * placeholder rather than emitting a message the client would throw on.
   * `viewerId` is needed to compute each reaction summary's `mine` flag
   * (mirrors `CommunityPostsService.toPostDTOs` — one `IN`-batched reactions
   * query across the whole page rather than per-message lookups).
   */
  async toMessageResponses(
    rows: MessageLike[],
    viewerId: string,
  ): Promise<MessageResponse[]> {
    if (!rows.length) {
      return [];
    }
    const messageIds = rows.map((m) => m.id);
    // Reply parents are fetched `withDeleted` so a soft-deleted original still
    // resolves to a "deleted" quote rather than silently vanishing (see
    // `buildReplyTo`). Their FK is `ON DELETE SET NULL`, so a hard-removed
    // parent just leaves `replyToId` absent from `parentById` — also handled
    // as `deleted: true`.
    const replyIds = [
      ...new Set(
        rows.map((m) => m.replyToId).filter((id): id is string => Boolean(id)),
      ),
    ];
    const parents = replyIds.length
      ? await this.messages.find({
          where: { id: In(replyIds) },
          withDeleted: true,
        })
      : [];
    const parentById = new Map(parents.map((parent) => [parent.id, parent]));
    // Sender profiles must cover the rows' own senders, the reply parents'
    // senders (so `buildReplyTo` resolves a quoted author), AND every system
    // message's actor/target (so `buildSystemEvent` resolves "Ana added Bea"
    // without a per-message lookup).
    const systemUserIds = rows.flatMap((m) =>
      m.kind === MessageKind.System && m.systemEvent
        ? [m.systemEvent.actorId, m.systemEvent.targetId].filter(
            (id): id is string => Boolean(id),
          )
        : [],
    );
    const senderIds = [
      ...new Set([
        ...rows.map((m) => m.senderId),
        ...parents.map((parent) => parent.senderId),
        ...systemUserIds,
      ]),
    ];
    // Delivered watermark for the "double check": how far the OTHER
    // participant(s) have acked receipt. All rows in a call share one
    // conversation, so one query suffices. `otherDeliveredAt` is the EARLIEST
    // delivered watermark across every non-viewer participant (null if there are
    // none, or if any hasn't acked) — i.e. "delivered to all present recipients",
    // which for a 1:1 DM is simply the single counterpart's watermark.
    const conversationId = rows[0]!.conversationId;
    const [
      senders,
      reactionsByMessage,
      otherParticipantRows,
      pinRows,
      starRows,
      viewer,
      moderationRows,
    ] = await Promise.all([
      this.profiles.find({ where: { userId: In(senderIds) } }),
      this.reactionSummariesByMessage(messageIds, viewerId),
      this.participants.find({
        where: { conversationId, userId: Not(viewerId) },
      }),
      // Shared pins for these messages (viewer-agnostic — both participants
      // see the same pinnedAt) and THIS viewer's private stars, batched by id.
      this.pins.find({ where: { messageId: In(messageIds) } }),
      this.stars.find({
        where: { userId: viewerId, messageId: In(messageIds) },
      }),
      // ONE lookup for the whole page (not per-message) of whether the viewer
      // is platform staff — feeds `canDelete` below, mirroring
      // `MessagesService.deleteMessage`'s own staff check exactly.
      this.usersService.findById(viewerId),
      // Moderator takedowns for this page of messages, in ONE `IN(...)` query
      // (subject key is the message uuid). A hidden/removed message is rendered
      // as a tombstone below — the messaging mirror of the forum/community
      // read-enforcement, gap-free because a tombstone still occupies its slot.
      this.moderationStates.find({
        where: {
          subjectType: MessagingCoreService.MESSAGE_SUBJECT_TYPE,
          subjectId: In(messageIds),
        },
      }),
    ]);
    const viewerIsStaff =
      viewer?.role === UserRole.Admin || viewer?.role === UserRole.Moderator;
    // subjectId -> its takedown row, so each message can resolve the tombstone
    // timestamp its `deletedAt` will carry.
    const moderationByMessage = new Map(
      moderationRows.map((row) => [row.subjectId, row]),
    );
    const pinnedAtByMessage = new Map(
      pinRows.map((pin) => [pin.messageId, pin.pinnedAt]),
    );
    const starredMessageIds = new Set(starRows.map((star) => star.messageId));
    // Only PRESENT recipients count toward "delivered to all" — a member who left
    // a group will never ack, so including them would peg the tick at one check
    // forever. For a 1:1 DM this is just the single counterpart.
    const presentRecipients = otherParticipantRows.filter(
      (row) => row.leftAt == null,
    );
    const deliveredWatermarks = presentRecipients
      .map((row) => row.deliveredAt)
      .filter((value): value is Date => value != null);
    // "Delivered to all present recipients": every present non-viewer participant
    // must have acked, then take the EARLIEST of their watermarks (for a 1:1 DM
    // that is just the single counterpart's).
    const otherDeliveredAt =
      presentRecipients.length > 0 &&
      deliveredWatermarks.length === presentRecipients.length
        ? deliveredWatermarks.reduce((earliest, value) =>
            value < earliest ? value : earliest,
          )
        : null;
    const profileByUser = new Map(senders.map((p) => [p.userId, p]));
    return rows.map((m) => {
      // A moderator takedown tombstones the message the same way an author's
      // own soft-delete does. A `remove_content` takedown (`removedAt`) hides
      // it from EVERYONE; a `hide_content` takedown (`hiddenAt` without
      // `removedAt`) hides it from ordinary participants but stays visible to
      // platform staff — the exact hidden/removed split forum/community use.
      // `deletedAt` carries the takedown timestamp so the client renders its
      // existing tombstone (it keys purely on `deletedAt` being set).
      const moderation = moderationByMessage.get(m.id);
      const moderationTombstoneAt = moderation
        ? (moderation.removedAt ?? (viewerIsStaff ? null : moderation.hiddenAt))
        : null;
      // A soft-deleted (or taken-down) row renders as a tombstone: id/sender/
      // createdAt are kept (so the thread still shows who/when), but `body`
      // and `reactions` are blanked rather than leaking the withheld content.
      const effectiveDeletedAt = m.deletedAt ?? moderationTombstoneAt;
      const isDeleted = Boolean(effectiveDeletedAt);
      // Delivered only applies to the viewer's OWN outgoing messages (the only
      // side that renders a delivery tick), and only once the recipient's
      // watermark has reached this message. The watermark ISO is a truthful
      // upper bound on the arrival time.
      const delivered =
        m.senderId === viewerId &&
        otherDeliveredAt !== null &&
        m.createdAt <= otherDeliveredAt;
      const isAuthor = m.senderId === viewerId;
      // Identical predicate to `MessagesService.editMessage`'s own guard
      // (same `EDIT_WINDOW_MS` constant), so this flag can never promise an
      // edit the endpoint would then reject.
      const withinEditWindow =
        Date.now() - m.createdAt.getTime() <= EDIT_WINDOW_MS;
      return {
        id: m.id,
        conversationId: m.conversationId,
        body: isDeleted ? '' : m.body,
        sender: requireAuthorSummary(profileByUser.get(m.senderId)),
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        reactions: isDeleted ? [] : (reactionsByMessage.get(m.id) ?? []),
        deletedAt: effectiveDeletedAt ? effectiveDeletedAt.toISOString() : null,
        deliveredAt: delivered ? otherDeliveredAt.toISOString() : null,
        clientMessageId: m.clientMessageId,
        forwarded: m.forwarded,
        // A tombstone carries no pin/star affordance; otherwise expose the shared
        // pin timestamp, this viewer's private star, and whether they may pin.
        pinnedAt: isDeleted
          ? null
          : (pinnedAtByMessage.get(m.id)?.toISOString() ?? null),
        starred: isDeleted ? false : starredMessageIds.has(m.id),
        canPin: !isDeleted,
        // Mirrors `MessagesService.editMessage`/`deleteMessage`'s own guards
        // exactly (author + window; author-or-staff) so the client never
        // offers an action the endpoint would then reject. `canReport`
        // excludes the author's own messages and tombstones (nothing left to
        // report).
        canEdit: !isDeleted && isAuthor && withinEditWindow,
        canDelete: !isDeleted && (isAuthor || viewerIsStaff),
        canReport: !isDeleted && !isAuthor,
        replyTo: buildReplyTo(m.replyToId, parentById, profileByUser),
        // Timeline kind + resolved system event. A `user` message carries a null
        // event; a `system` one resolves actor/target ids to display names so the
        // client renders bilingual templates ("You created the group", "Ana
        // added Bea") without ever seeing a user id.
        kind: messageKindToResponseKind(m.kind),
        attachment: isDeleted ? null : resolveAttachment(m.attachment),
        systemEvent:
          m.kind === MessageKind.System
            ? buildSystemEvent(m.systemEvent, profileByUser)
            : null,
      };
    });
  }

  /**
   * Single internal write path. Persists a message and emits MESSAGE_CREATED
   * (which the gateway relays as `message:new` and the push/notification
   * listeners consume). Returns BOTH the internal `MessageView` and the
   * frontend-contract `MessageResponse` so callers reuse the one hydration.
   *
   * Idempotent when `clientMessageId` is supplied: a second write with the same
   * `(conversationId, clientMessageId)` — whether from the dual HTTP + WS paths
   * or an offline-outbox retry — returns the already-stored message and does
   * NOT re-emit MESSAGE_CREATED (so no duplicate broadcast/push/notification).
   */
  async postMessage(
    conversationId: string,
    senderId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image',
    attachment?: GifAttachment,
  ): Promise<{ view: MessageView; response: MessageResponse }> {
    if (clientMessageId) {
      const existing = await this.messages.findOne({
        where: { conversationId, clientMessageId },
        withDeleted: true,
      });
      if (existing) {
        return this.buildPostResult(existing, senderId, false);
      }
    }
    if ((kind === 'gif' || kind === 'image') && !attachment) {
      throw new BadRequestException(
        `attachment is required for a ${kind} message`,
      );
    }
    if (kind === 'gif' && attachment && !/^https:\/\//.test(attachment.url)) {
      throw new BadRequestException('A gif attachment must be an https URL');
    }
    if (kind === 'image' && attachment) {
      // A forwarded image's `url`/`previewUrl` arrive as the ALREADY-RESOLVED
      // `GET /files/<key>` URL (the forwarded ChatMessage's attachment came
      // from a server response, which resolves keys at read time — see
      // `resolveAttachment`), not the bare key a fresh upload sends. Collapse
      // either shape back to the canonical bare key before validating or
      // persisting — the storage layer stores keys, never URLs (mirrors every
      // other image field via `storageKeyFromImageUrl`), and this is also what
      // makes the ownership check below correct for a forward, not just a
      // fresh send.
      attachment = {
        ...attachment,
        url: storageKeyFromImageUrl(attachment.url),
        previewUrl: storageKeyFromImageUrl(attachment.previewUrl),
      };
      // The attachment's `url` must be a well-formed `message-image` storage
      // key — otherwise any authenticated member could attach an arbitrary
      // key (an unrelated kind's, or a malformed string) to a message. 404-
      // style rejection posture doesn't apply here (unlike `FilesController`,
      // nothing is disclosed either way) — a plain 400 is correct.
      if (parseStorageKey(attachment.url) !== UPLOAD_KIND_SPECS['message-image']) {
        throw new BadRequestException('Invalid image attachment');
      }
      // A FRESH send must additionally be the sender's OWN upload — the abuse
      // this guards against is attaching someone else's private key to a
      // message you didn't upload it into. A FORWARD is exempt: it re-sends
      // an existing message's attachment (the forwarder already saw the image
      // as a participant of the original conversation, and the key's shape
      // was already validated above), so requiring the forwarder to also be
      // the original uploader would break the ordinary "forward a photo"
      // action for no real safety gain.
      if (!forwarded && storageKeyOwnerId(attachment.url) !== senderId) {
        throw new ForbiddenException(
          'You may only attach an image you uploaded',
        );
      }
    }
    const entityKind =
      kind === 'gif'
        ? MessageKind.Gif
        : kind === 'image'
          ? MessageKind.Image
          : MessageKind.User;
    let saved: Message;
    try {
      saved = await this.messages.save(
        this.messages.create({
          conversationId,
          senderId,
          body,
          replyToId: replyToId ?? null,
          clientMessageId: clientMessageId ?? null,
          forwarded: forwarded ?? false,
          kind: entityKind,
          // Only a gif/image message carries an attachment — never persist one
          // onto a plain text send even if a client mistakenly supplies both.
          attachment:
            kind === 'gif' || kind === 'image' ? (attachment ?? null) : null,
        }),
      );
    } catch (error) {
      // Lost the race with a concurrent identical write (the partial unique
      // index fired, code 23505): fetch and return the winner — still idempotent.
      if (
        clientMessageId &&
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string } | undefined)?.code === '23505'
      ) {
        const winner = await this.messages.findOne({
          where: { conversationId, clientMessageId },
          withDeleted: true,
        });
        if (winner) {
          return this.buildPostResult(winner, senderId, false);
        }
      }
      throw error;
    }
    return this.buildPostResult(saved, senderId, true);
  }

  /**
   * Maps a freshly-written (or deduped) message to the internal view + frontend
   * response, emitting MESSAGE_CREATED only for a genuine first insert. The
   * response's reaction `mine` flags are computed for `senderId`; that is
   * correct because a brand-new message carries no reactions, and an idempotent
   * re-return only happens for the original sender resending their own id.
   */
  async buildPostResult(
    message: Message,
    senderId: string,
    emit: boolean,
  ): Promise<{ view: MessageView; response: MessageResponse }> {
    const view = toMessageView(message);
    const [response] = await this.toMessageResponses([message], senderId);
    // invariant: toMessageResponses returns one response per input row.
    if (emit) {
      this.eventEmitter.emit(MESSAGE_CREATED, {
        conversationId: message.conversationId,
        message: view,
        response: response!,
      } satisfies MessageCreatedEvent);
    }
    return { view, response: response! };
  }

  pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  async getOrCreateConversation(
    a: string,
    b: string,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const pairKey = this.pairKey(a, b);
    const existing = await this.conversations.findOne({ where: { pairKey } });
    if (existing) {
      return { conversation: existing, created: false };
    }
    try {
      const conversation = await this.dataSource.transaction(
        async (manager) => {
          const convo = await manager.save(
            manager.create(Conversation, { isOfficial: false, pairKey }),
          );
          await manager.save([
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: a,
            }),
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: b,
            }),
          ]);
          return convo;
        },
      );
      return { conversation, created: true };
    } catch (err) {
      // Lost a concurrent create race on the UNIQUE pair_key — return the winner.
      if (
        err instanceof QueryFailedError &&
        (err.driverError as { code?: string })?.code === '23505'
      ) {
        const winner = await this.conversations.findOne({
          where: { pairKey },
        });
        if (winner) {
          return { conversation: winner, created: false };
        }
      }
      throw err;
    }
  }
}
