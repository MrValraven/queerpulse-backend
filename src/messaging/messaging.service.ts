import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, QueryFailedError, Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
} from '../connections/connection.events';
import { ConnectionsService } from '../connections/connections.service';
import { decodeCursor } from '../common/cursor-pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { Message } from './entities/message.entity';
import {
  AuthorSummary,
  buildReplyTo,
  ConversationResponse,
  MessageResponse,
  MessageView,
  ReactionSummary,
  requireAuthorSummary,
  toAuthorSummary,
  toMessageReactionSummaries,
  toMessageView,
} from './message-response';
import {
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_READ,
  MESSAGE_REACTION,
  MESSAGE_UPDATED,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageReadEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
} from './messaging.events';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const EDIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The fields needed to build a `MessageResponse`. Structural, so both a
 * persisted `Message` row and the internal `MessageView` satisfy it.
 */
type MessageLike = Pick<
  Message,
  | 'id'
  | 'conversationId'
  | 'senderId'
  | 'body'
  | 'replyToId'
  | 'createdAt'
  | 'editedAt'
  | 'deletedAt'
>;

@Injectable()
export class MessagingService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(MessageReaction)
    private readonly reactions: Repository<MessageReaction>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly usersService: UsersService,
  ) {}

  async listConversations(userId: string): Promise<ConversationResponse[]> {
    const myParts = await this.participants.find({ where: { userId } });
    if (!myParts.length) {
      return [];
    }
    const clearedAtByConversation = new Map<string, Date>();
    for (const part of myParts) {
      if (part.clearedAt) {
        clearedAtByConversation.set(part.conversationId, part.clearedAt);
      }
    }
    const convoIds = myParts.map((p) => p.conversationId);
    const convos = await this.conversations.find({
      where: { id: In(convoIds) },
    });
    const convoById = new Map(convos.map((c) => [c.id, c]));

    // All non-self participants, grouped per conversation. A 1:1 thread has
    // exactly one counterpart; official/welcome threads may have several (or
    // none), so keep arrays and render explicitly by `isOfficial` below rather
    // than letting a Map overwrite pick an arbitrary "other".
    const others = await this.participants.find({
      where: { conversationId: In(convoIds), userId: Not(userId) },
    });
    const othersByConvo = new Map<string, ConversationParticipant[]>();
    for (const o of others) {
      const list = othersByConvo.get(o.conversationId);
      if (list) {
        list.push(o);
      } else {
        othersByConvo.set(o.conversationId, [o]);
      }
    }
    // Include the caller's own profile: they may be the sender of a thread's
    // last message, and `MessageResponse.sender` is non-nullable.
    const relevantProfiles = await this.profiles.find({
      where: { userId: In([...others.map((o) => o.userId), userId]) },
    });
    const profileByUser = new Map(relevantProfiles.map((p) => [p.userId, p]));

    // One query for the newest (non-deleted) message per conversation and one
    // grouped query for this user's unread counts — replaces the previous
    // per-conversation findOne + count (N+1).
    const [lastByConvo, unreadByConvo] = await Promise.all([
      this.lastMessagesByConversation(convoIds),
      this.unreadCountsByConversation(convoIds, userId),
    ]);
    const reactionsByMessage = await this.reactionSummariesByMessage(
      [...lastByConvo.values()].map((m) => m.id),
      userId,
    );

    const summaries: ConversationResponse[] = [];
    for (const part of myParts) {
      const convo = convoById.get(part.conversationId);
      if (!convo) {
        continue;
      }
      let otherParticipant: AuthorSummary | null = null;
      // 1:1 thread: the single counterpart. Official/welcome threads have no
      // "other participant" — the client shows the org identity instead —
      // so `first` stays undefined and the fields below fall back to null.
      const first = convo.isOfficial
        ? undefined
        : othersByConvo.get(convo.id)?.[0];
      if (!convo.isOfficial) {
        otherParticipant = toAuthorSummary(
          first ? profileByUser.get(first.userId) : undefined,
        );
      }
      const lastMessage = lastByConvo.get(convo.id) ?? null;
      const cleared = clearedAtByConversation.get(convo.id) ?? null;
      // A thread the caller cleared, with no newer message, is invisible to
      // them — drop it. A `lastMessage` older than the floor is likewise gone;
      // treat the thread as empty (a still-present preview would leak cleared
      // history). A later message (createdAt > clearedAt) survives this and the
      // thread reappears with fresh history only.
      const clearedLastMessage =
        cleared && lastMessage && lastMessage.createdAt <= cleared
          ? null
          : lastMessage;
      if (cleared && !clearedLastMessage) {
        continue;
      }
      summaries.push({
        id: convo.id,
        type: convo.isOfficial ? 'group' : 'dm',
        otherParticipant,
        lastMessage: clearedLastMessage
          ? {
              id: clearedLastMessage.id,
              conversationId: convo.id,
              body: clearedLastMessage.body,
              sender: requireAuthorSummary(
                profileByUser.get(clearedLastMessage.senderId),
              ),
              createdAt: clearedLastMessage.createdAt.toISOString(),
              editedAt: clearedLastMessage.editedAt
                ? clearedLastMessage.editedAt.toISOString()
                : null,
              reactions: reactionsByMessage.get(clearedLastMessage.id) ?? [],
              // `lastMessagesByConversation` never returns a soft-deleted row.
              deletedAt: null,
              // Conversation-list previews don't resolve reply quotes — only
              // the message-thread view (`toMessageResponses`) does.
              replyTo: null,
            }
          : null,
        unreadCount: unreadByConvo.get(convo.id) ?? 0,
        // `conversations` has no updated_at column (schema is migration-owned
        // and this workstream adds none), so last activity is derived: the
        // newest message, or the thread's own creation for an empty thread.
        updatedAt: (
          clearedLastMessage?.createdAt ?? convo.createdAt
        ).toISOString(),
        otherLastReadAt: first?.lastReadAt?.toISOString() ?? null,
        otherParticipantId: first?.userId ?? null,
        isOfficial: convo.isOfficial,
        muted: part.muted,
      });
    }
    // Most recently active first. ISO-8601 UTC strings are fixed-width, so
    // lexicographic order is chronological order.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /** Newest non-deleted message per conversation, in one DISTINCT ON pass. */
  private async lastMessagesByConversation(
    convoIds: string[],
  ): Promise<Map<string, Message>> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .distinctOn(['m.conversation_id'])
      .where('m.conversation_id IN (:...convoIds)', { convoIds })
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
  private async unreadCountsByConversation(
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
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string; count: string }>();
    return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
  }

  /**
   * Reaction summaries (per-key count + `mine`) for a batch of messages —
   * shared by the "last message" preview built inline by `listConversations`/
   * `toConversationResponse` and by `toMessageResponses`, so all three surface
   * the same shape without a per-message query.
   */
  private async reactionSummariesByMessage(
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

  async getMessages(
    conversationId: string,
    userId: string,
    opts: {
      before?: string;
      beforeId?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<MessageResponse[]> {
    const participant = await this.requireParticipant(conversationId, userId);
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // An explicit `before`/`beforeId` wins; otherwise decode the frontend's
    // opaque `cursor` onto the same (createdAt, id) keyset predicate. A
    // malformed cursor decodes to `null` and is treated as no cursor (first
    // page) rather than rejecting the request.
    let before = opts.before;
    let beforeId = opts.beforeId;
    if (!before && opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        before = decoded.createdAt.toISOString();
        beforeId = decoded.id;
      }
    }
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :id', { id: conversationId });
    if (participant.clearedAt) {
      // History is floored at the caller's clear point: messages at-or-before
      // it don't exist for them (WhatsApp "cleared" semantics). The other
      // participant, with their own (or no) clearedAt, still sees everything.
      qb.andWhere('m.created_at > :clearedAt', {
        clearedAt: participant.clearedAt.toISOString(),
      });
    }
    if (before) {
      if (beforeId) {
        // Composite keyset cursor: strictly "older" than (before, beforeId) in
        // the (created_at DESC, id DESC) ordering, so messages sharing the same
        // millisecond as the page boundary are neither skipped nor duplicated.
        qb.andWhere(
          '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
          { before, beforeId },
        );
      } else {
        qb.andWhere('m.created_at < :before', { before });
      }
    }
    // @DeleteDateColumn makes the QueryBuilder exclude soft-deleted rows by
    // default; `.withDeleted()` overrides that here so a deleted message still
    // renders as a tombstone in the thread rather than vanishing (leaving a
    // gap the other participant's "seen" reply would otherwise dangle from).
    // `lastMessagesByConversation` (inbox preview) does NOT call this — the
    // preview intentionally keeps showing the last non-deleted message.
    const rows = await qb
      .withDeleted()
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit)
      .getMany();
    return this.toMessageResponses(rows, userId);
  }

  /**
   * Hydrates sender profiles and reactions onto a page of messages in two
   * batched queries and maps to the frontend-contract `MessageResponse`.
   * `sender` is non-nullable there — the frontend adapter reads
   * `sender.displayName` unguarded — so this goes through
   * `requireAuthorSummary`, which supplies a placeholder rather than emitting
   * a message the client would throw on. `viewerId` is needed to compute each
   * reaction summary's `mine` flag (mirrors `CommunityPostsService.toPostDTOs`
   * — one `IN`-batched reactions query across the whole page rather than
   * per-message lookups).
   */
  private async toMessageResponses(
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
      ...new Set(rows.map((m) => m.replyToId).filter((id): id is string => Boolean(id))),
    ];
    const parents = replyIds.length
      ? await this.messages.find({
          where: { id: In(replyIds) },
          withDeleted: true,
        })
      : [];
    const parentById = new Map(parents.map((parent) => [parent.id, parent]));
    // Sender profiles must cover both the rows' own senders AND the reply
    // parents' senders, so `buildReplyTo` can resolve a quoted message's
    // author name even when that author never sent anything in this page.
    const senderIds = [
      ...new Set([
        ...rows.map((m) => m.senderId),
        ...parents.map((parent) => parent.senderId),
      ]),
    ];
    const [senders, reactionsByMessage] = await Promise.all([
      this.profiles.find({ where: { userId: In(senderIds) } }),
      this.reactionSummariesByMessage(messageIds, viewerId),
    ]);
    const profileByUser = new Map(senders.map((p) => [p.userId, p]));
    return rows.map((m) => {
      // A soft-deleted row renders as a tombstone: id/sender/createdAt are
      // kept (so the thread still shows who/when), but `body` and
      // `reactions` are blanked rather than leaking the deleted content.
      const isDeleted = Boolean(m.deletedAt);
      return {
        id: m.id,
        conversationId: m.conversationId,
        body: isDeleted ? '' : m.body,
        sender: requireAuthorSummary(profileByUser.get(m.senderId)),
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        reactions: isDeleted ? [] : (reactionsByMessage.get(m.id) ?? []),
        deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        replyTo: buildReplyTo(m.replyToId, parentById, profileByUser),
      };
    });
  }

  async sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
  ): Promise<MessageResponse> {
    await this.requireParticipant(conversationId, userId);
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo) {
      throw new NotFoundException('Conversation not found');
    }
    if (!convo.isOfficial) {
      const other = await this.participants.findOne({
        where: { conversationId, userId: Not(userId) },
      });
      if (
        other &&
        !(await this.connectionsService.areConnected(userId, other.userId))
      ) {
        throw new ForbiddenException(
          'You can only message accepted connections',
        );
      }
    }
    if (replyToId) {
      // The parent must live in THIS conversation — otherwise a participant
      // of conversation A could reply-quote a message that only exists in
      // conversation B.
      const parent = await this.messages.findOne({
        where: { id: replyToId, conversationId },
      });
      if (!parent) {
        throw new NotFoundException('Replied-to message not found');
      }
    }
    // `postMessage` stays on the internal `MessageView` — it is also the
    // MESSAGE_CREATED event payload and backs `POST /messages/request`. Only
    // the HTTP/WS send path is mapped to the frontend contract.
    const view = await this.postMessage(
      conversationId,
      userId,
      body,
      replyToId,
    );
    const [response] = await this.toMessageResponses([view], userId);
    return response;
  }

  async markRead(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    // Stamp the read watermark with the DB clock (now()) so it is directly
    // comparable to DB-generated message timestamps — using the app server's
    // new Date() risks clock skew that skips or double-counts unread messages.
    await this.participants.update(
      { conversationId, userId },
      { lastReadAt: () => 'now()' },
    );
    const updated = await this.participants.findOne({
      where: { conversationId, userId },
    });
    const lastReadAt = updated?.lastReadAt ?? new Date();
    this.eventEmitter.emit(MESSAGE_READ, {
      conversationId,
      userId,
      lastReadAt,
    } satisfies MessageReadEvent);
    return { ok: true };
  }

  /**
   * Delete a conversation "for me only" (WhatsApp-style): stamp this
   * participant's `clearedAt` with the DB clock. Reads then hide the thread and
   * every message at-or-before that instant FOR THIS USER; the other
   * participant is untouched. A later incoming message (createdAt > clearedAt)
   * naturally resurfaces the thread with fresh history only. Idempotent — a
   * repeat delete just re-stamps a slightly later `clearedAt`, still hiding
   * everything older. Uses now() (not new Date()) to stay clock-comparable to
   * message timestamps, mirroring markRead.
   */
  async clearConversation(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { clearedAt: () => 'now()' },
    );
    return { ok: true };
  }

  async setMuted(
    conversationId: string,
    userId: string,
    muted: boolean,
  ): Promise<{ ok: true }> {
    const part = await this.requireParticipant(conversationId, userId);
    part.muted = muted;
    await this.participants.save(part);
    return { ok: true };
  }

  isParticipant(conversationId: string, userId: string): Promise<boolean> {
    return this.participants.exists({ where: { conversationId, userId } });
  }

  async addMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.requireMessageInConversation(conversationId, messageId);

    // Idempotent per (message,user,key): `ON CONFLICT DO NOTHING` absorbs a
    // re-react (or a race between two concurrent ones) without a pre-check +
    // 23505 — mirrors `CommunityPostsService.addReaction`'s insert idiom.
    await this.reactions
      .createQueryBuilder()
      .insert()
      .into(MessageReaction)
      .values({ messageId, userId, key })
      .orIgnore()
      .execute();

    this.eventEmitter.emit(MESSAGE_REACTION, {
      conversationId,
      messageId,
    } satisfies MessageReactionEvent);
    return { ok: true };
  }

  async removeMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.requireMessageInConversation(conversationId, messageId);

    await this.reactions.delete({ messageId, userId, key });

    this.eventEmitter.emit(MESSAGE_REACTION, {
      conversationId,
      messageId,
    } satisfies MessageReactionEvent);
    return { ok: true };
  }

  /**
   * Soft-delete a message, leaving a tombstone (`toMessageResponses` blanks
   * `body`/`reactions` for any row with `deletedAt` set). Two actor classes
   * may delete: the message's own author, or platform staff (admin/mod) —
   * mirrors `ChatGateway.assertNotLockedOut`'s staff predicate, but the role
   * has to be loaded from the DB here too since there is no request/token
   * claim carrying it in this service.
   *
   * Idempotent: deleting an already-deleted message is a no-op success
   * rather than a 404/409 — a double-click or a retried request shouldn't
   * surface an error for a delete that already "happened".
   */
  async deleteMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    // `withDeleted` so a second delete call can see its own tombstone and
    // short-circuit instead of 404ing — the default findOne would filter it out.
    const message = await this.messages.findOne({
      where: { id: messageId, conversationId },
      withDeleted: true,
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    if (message.deletedAt) {
      return { ok: true };
    }

    const isAuthor = message.senderId === userId;
    if (!isAuthor) {
      const actor = await this.usersService.findById(userId);
      const isStaff =
        actor?.role === UserRole.Admin || actor?.role === UserRole.Moderator;
      if (!isStaff) {
        throw new ForbiddenException('You can only delete your own messages');
      }
    }

    message.deletedAt = new Date();
    await this.messages.save(message);

    this.eventEmitter.emit(MESSAGE_DELETED, {
      conversationId,
      messageId,
    } satisfies MessageDeletedEvent);
    return { ok: true };
  }

  /**
   * Edit a message's `body` in place. Author-only, within a 15-minute window
   * of `createdAt`, and only while the message is not (soft-)deleted. Stamps
   * `editedAt` and emits `MESSAGE_UPDATED` so live sockets in the conversation
   * see the new body — mirrors `deleteMessage`'s guard shape but is stricter:
   * this is not idempotent (a repeat call keeps overwriting the body/edited
   * timestamp) and the edit window is enforced on the server as the authority,
   * even though the client also hides the Edit action past 15 minutes.
   */
  async editMessage(
    conversationId: string,
    messageId: string,
    userId: string,
    body: string,
  ): Promise<MessageResponse> {
    await this.requireParticipant(conversationId, userId);
    const message = await this.messages.findOne({
      where: { id: messageId, conversationId },
    });
    if (!message || message.deletedAt) {
      throw new NotFoundException('Message not found');
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new ForbiddenException('The edit window has expired');
    }
    message.body = body;
    message.editedAt = new Date();
    const saved = await this.messages.save(message);
    const view = toMessageView(saved);
    this.eventEmitter.emit(MESSAGE_UPDATED, {
      conversationId,
      message: view,
    } satisfies MessageUpdatedEvent);
    const [response] = await this.toMessageResponses([view], userId);
    return response;
  }

  /**
   * `POST /conversations` — create-or-return the DM with `recipientHandle`
   * (this backend's `slug`). Thin wrapper over the same
   * `getOrCreateConversation` helper `messageRequest` uses, minus the
   * required first message: opening a thread from a profile shouldn't force
   * the caller to have already typed something, and this is intentionally
   * idempotent (repeat calls return the same conversation). No connection
   * check here — `sendMessage` already gates actually messaging — but a
   * block either way is a hard stop: a blocked user cannot even open a
   * thread.
   */
  async createConversation(
    userId: string,
    recipientHandle: string,
  ): Promise<ConversationResponse> {
    const recipient = await this.profiles.findOne({
      where: { slug: recipientHandle },
    });
    if (!recipient) {
      throw new NotFoundException('Member not found');
    }
    if (recipient.userId === userId) {
      throw new BadRequestException(
        'You cannot start a conversation with yourself',
      );
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, recipient.userId)) {
      throw new ForbiddenException(
        'You cannot start a conversation with this member',
      );
    }

    const { conversation } = await this.getOrCreateConversation(
      userId,
      recipient.userId,
    );
    return this.toConversationResponse(conversation, userId, recipient.userId);
  }

  /** Builds the frontend-contract `ConversationResponse` for a 1:1 DM. */
  private async toConversationResponse(
    convo: Conversation,
    userId: string,
    otherUserId: string,
  ): Promise<ConversationResponse> {
    const [
      profiles,
      lastByConvo,
      unreadByConvo,
      otherParticipantRow,
      callerParticipantRow,
    ] = await Promise.all([
      this.profiles.find({ where: { userId: In([userId, otherUserId]) } }),
      this.lastMessagesByConversation([convo.id]),
      this.unreadCountsByConversation([convo.id], userId),
      this.participants.findOne({
        where: { conversationId: convo.id, userId: otherUserId },
      }),
      this.participants.findOne({
        where: { conversationId: convo.id, userId },
      }),
    ]);
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const lastMessage = lastByConvo.get(convo.id) ?? null;
    const clearedAt = callerParticipantRow?.clearedAt ?? null;
    // Mirror listConversations: a last message at-or-before the caller's clear
    // point does not exist for them, so it must not appear in the preview.
    const clearedLastMessage =
      clearedAt && lastMessage && lastMessage.createdAt <= clearedAt
        ? null
        : lastMessage;
    const reactionsByMessage = await this.reactionSummariesByMessage(
      clearedLastMessage ? [clearedLastMessage.id] : [],
      userId,
    );

    return {
      id: convo.id,
      type: convo.isOfficial ? 'group' : 'dm',
      otherParticipant: toAuthorSummary(profileByUser.get(otherUserId)),
      lastMessage: clearedLastMessage
        ? {
            id: clearedLastMessage.id,
            conversationId: convo.id,
            body: clearedLastMessage.body,
            sender: requireAuthorSummary(
              profileByUser.get(clearedLastMessage.senderId),
            ),
            createdAt: clearedLastMessage.createdAt.toISOString(),
            editedAt: clearedLastMessage.editedAt
              ? clearedLastMessage.editedAt.toISOString()
              : null,
            reactions: reactionsByMessage.get(clearedLastMessage.id) ?? [],
            // `lastMessagesByConversation` never returns a soft-deleted row.
            deletedAt: null,
            // Conversation-list previews don't resolve reply quotes — only
            // the message-thread view (`toMessageResponses`) does.
            replyTo: null,
          }
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      otherLastReadAt: otherParticipantRow?.lastReadAt?.toISOString() ?? null,
      otherParticipantId: otherParticipantRow?.userId ?? null,
    };
  }

  async messageRequest(
    userId: string,
    toSlug: string,
    body: string,
  ): Promise<{
    conversationId: string | null;
    message: MessageView | null;
    connectionRequestId: string | null;
  }> {
    const recipient = await this.profiles.findOne({ where: { slug: toSlug } });
    if (!recipient) {
      throw new NotFoundException('Member not found');
    }
    if (recipient.userId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, recipient.userId)) {
      throw new ForbiddenException('You cannot message this member');
    }

    if (await this.connectionsService.areConnected(userId, recipient.userId)) {
      const { conversation } = await this.getOrCreateConversation(
        userId,
        recipient.userId,
      );
      const message = await this.postMessage(conversation.id, userId, body);
      return {
        conversationId: conversation.id,
        message,
        connectionRequestId: null,
      };
    }

    // Not connected: the message becomes the seed of a connection request (§7).
    const conn = await this.connectionsService.requestConnection(
      userId,
      toSlug,
      body,
    );
    return {
      conversationId: null,
      message: null,
      connectionRequestId: conn.id,
    };
  }

  /**
   * Delivers a one-off message from `fromUserId` to `toUserId`, addressed by
   * userId (not slug), creating the 1:1 conversation if needed. Unlike
   * `sendMessage`/`messageRequest`, this intentionally does NOT require the two
   * to be accepted connections — it backs cold cross-domain contact such as a
   * housing enquiry, where a pre-existing friendship must not be a precondition.
   * A block either way is still a hard stop.
   */
  async deliverEnquiry(
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string }> {
    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot send an enquiry to yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      throw new ForbiddenException('You cannot contact this member');
    }
    const { conversation } = await this.getOrCreateConversation(
      fromUserId,
      toUserId,
    );
    await this.postMessage(conversation.id, fromUserId, body);
    return { conversationId: conversation.id };
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async handleConnectionAccepted(
    payload: ConnectionAcceptedEvent,
  ): Promise<void> {
    const { conversation, created } = await this.getOrCreateConversation(
      payload.requesterId,
      payload.addresseeId,
    );
    // Seed the request message only on first materialization (idempotent if the
    // event ever re-fires).
    if (created && payload.requestMessage) {
      await this.postMessage(
        conversation.id,
        payload.requesterId,
        payload.requestMessage,
      );
    }
  }

  // --- internals ---

  private async requireParticipant(
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

  // Reactions are addressed by (conversationId, messageId): confirms the
  // message actually belongs to the conversation the caller is a participant
  // of, so a participant of conversation A cannot react to a message that
  // only lives in conversation B.
  private async requireMessageInConversation(
    conversationId: string,
    messageId: string,
  ): Promise<Message> {
    const message = await this.messages.findOne({
      where: { id: messageId, conversationId },
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    return message;
  }

  private async postMessage(
    conversationId: string,
    senderId: string,
    body: string,
    replyToId?: string,
  ): Promise<MessageView> {
    const saved = await this.messages.save(
      this.messages.create({
        conversationId,
        senderId,
        body,
        replyToId: replyToId ?? null,
      }),
    );
    const view = toMessageView(saved);
    // Single internal write path; the Phase 7b gateway broadcasts on this event.
    this.eventEmitter.emit(MESSAGE_CREATED, {
      conversationId,
      message: view,
    } satisfies MessageCreatedEvent);
    return view;
  }

  private pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  private async getOrCreateConversation(
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
