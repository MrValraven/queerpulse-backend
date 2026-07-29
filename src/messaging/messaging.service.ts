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
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind, SystemEvent } from './entities/message.entity';
import {
  AuthorSummary,
  buildReplyTo,
  buildSystemEvent,
  ConversationMemberSummary,
  ConversationResponse,
  MessageResponse,
  MessageSearchConversationGroup,
  MessageSearchResponse,
  MessageView,
  ReactionSummary,
  requireAuthorSummary,
  StarredMessageHit,
  StarredMessagesResponse,
  toAuthorSummary,
  toMessageReactionSummaries,
  toMessageView,
} from './message-response';
import { toImageUrl } from '../common/image-url';
import {
  CONVERSATION_CREATED,
  ConversationCreatedEvent,
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_DELIVERED,
  MESSAGE_PINNED,
  MESSAGE_READ,
  MESSAGE_REACTION,
  MESSAGE_UPDATED,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageDeliveredEvent,
  MessagePinnedEvent,
  MessageReadEvent,
  MessageReactionCount,
  MessageReactionEvent,
  MessageUpdatedEvent,
} from './messaging.events';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

/**
 * Plain-text `body` for each kind of system message. This is only a FALLBACK for
 * consumers that don't render the structured `systemEvent` (push previews,
 * search, the inbox preview in a non-group-aware client) — the actual timeline
 * pill is built by the CLIENT from `systemEvent`, bilingually. English by design
 * (server-stored content, like member/message text) — see the i18n note in
 * `catalogs/en/messages.ts`.
 */
const SYSTEM_EVENT_FALLBACK: Record<SystemEvent['type'], string> = {
  group_created: 'created the group',
  member_added: 'added a member',
  member_removed: 'removed a member',
  member_left: 'left the group',
  group_renamed: 'renamed the group',
};

/**
 * Group role precedence (lower = more powerful). Used by the server-side role
 * gate (`requireGroupRole`) and owner-succession so a single comparison covers
 * "owner > admin > member". NEVER derived from the client — the caller's role is
 * always re-read from their participant row.
 */
const ROLE_RANK: Record<ConversationRole, number> = {
  [ConversationRole.Owner]: 0,
  [ConversationRole.Admin]: 1,
  [ConversationRole.Member]: 2,
};

/**
 * Escapes the LIKE/ILIKE metacharacters in a user-supplied search term so they
 * match literally: `\` (the default escape char) first, then the `%`/`_`
 * wildcards. The escaped term is wrapped as `%term%` and passed as a bound
 * parameter — never string-interpolated — so the query is injection-safe AND a
 * literal `%` in the term can't turn into a match-everything scan.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * A short window of `body` around the first case-insensitive occurrence of
 * `query`, with ellipses where it was cut — enough context to read the match
 * without returning (or storing on the client) the whole message. Falls back to
 * a head slice if the term somehow isn't found (it always is: the caller only
 * builds snippets for rows an `ILIKE %term%` already matched).
 */
function buildSearchSnippet(body: string, query: string): string {
  const LEAD = 40;
  const TRAIL = 90;
  const index = body.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return body.length > LEAD + TRAIL
      ? `${body.slice(0, LEAD + TRAIL).trimEnd()}…`
      : body;
  }
  const start = Math.max(0, index - LEAD);
  const end = Math.min(body.length, index + query.length + TRAIL);
  const core = body.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${core}${end < body.length ? '…' : ''}`;
}

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
  | 'clientMessageId'
  | 'forwarded'
  | 'kind'
  | 'systemEvent'
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
    @InjectRepository(ConversationPinnedMessage)
    private readonly pins: Repository<ConversationPinnedMessage>,
    @InjectRepository(MessageStar)
    private readonly stars: Repository<MessageStar>,
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
      const isGroup = convo.kind === ConversationKind.Group;
      const convoOthers = othersByConvo.get(convo.id) ?? [];
      let otherParticipant: AuthorSummary | null = null;
      // 1:1 thread: the single counterpart. Official/welcome AND group threads
      // have no single "other participant" — the client shows the org identity
      // or the group title instead — so `first` stays undefined and the
      // counterpart fields below fall back to null.
      const first =
        convo.isOfficial || isGroup ? undefined : convoOthers[0];
      if (!convo.isOfficial && !isGroup) {
        otherParticipant = toAuthorSummary(
          first ? profileByUser.get(first.userId) : undefined,
        );
      }
      // Group roster: this caller's own participant row (`part`) + every other
      // participant, mapped to member summaries with roles.
      const members = isGroup
        ? this.buildMemberSummaries([part, ...convoOthers], profileByUser)
        : [];
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
        type: isGroup || convo.isOfficial ? 'group' : 'dm',
        otherParticipant,
        lastMessage: clearedLastMessage
          ? this.buildLastMessagePreview(
              clearedLastMessage,
              convo.id,
              profileByUser,
              reactionsByMessage.get(clearedLastMessage.id) ?? [],
            )
          : null,
        unreadCount: unreadByConvo.get(convo.id) ?? 0,
        // `conversations` has no updated_at column (schema is migration-owned
        // and this workstream adds none), so last activity is derived: the
        // newest message, or the thread's own creation for an empty thread.
        updatedAt: (
          clearedLastMessage?.createdAt ?? convo.createdAt
        ).toISOString(),
        otherLastReadAt: first?.lastReadAt?.toISOString() ?? null,
        otherDeliveredAt: first?.deliveredAt?.toISOString() ?? null,
        otherParticipantId: first?.userId ?? null,
        kind: isGroup ? 'group' : 'direct',
        title: isGroup ? convo.title : null,
        avatarUrl: isGroup ? toImageUrl(convo.avatarUrl) : null,
        memberCount: members.length,
        members,
        isOfficial: convo.isOfficial,
        muted: part.muted,
        hasLeft: isGroup ? part.leftAt != null : false,
        ...(isGroup
          ? this.groupCapabilities(part.role, part.leftAt != null)
          : {}),
      });
    }
    // Most recently active first. ISO-8601 UTC strings are fixed-width, so
    // lexicographic order is chronological order.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /**
   * Builds the `lastMessage` inbox-preview `MessageResponse` shared by
   * `listConversations` and `toConversationResponse`. Previews carry no
   * delivery/pin/star/reply resolution (only the thread view does), but DO carry
   * `kind`/`systemEvent` so the inbox can render a system last message ("Ana
   * created the group") as its own line rather than a member-attributed bubble.
   */
  private buildLastMessagePreview(
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
      replyTo: null,
      kind: isSystem ? 'system' : 'user',
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
  private buildMemberSummaries(
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
  private groupCapabilities(
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
      after?: string;
      afterId?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<MessageResponse[]> {
    const participant = await this.requireParticipant(conversationId, userId);
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // Forward reconciliation (reconnect history sync): everything strictly NEWER
    // than the caller's last known (after, afterId), oldest→newest, so a client
    // that was offline while the socket buffered nothing can backfill the gap by
    // appending. Distinct from the default backward "load older" paging below.
    if (opts.after) {
      return this.getMessagesSince(
        conversationId,
        userId,
        participant.clearedAt,
        opts.after,
        opts.afterId,
        limit,
      );
    }
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
   * Messages strictly newer than the `(after, afterId)` keyset, oldest→newest,
   * capped at `limit`. Backs reconnect history sync: after a socket drop (which
   * buffers nothing) the client re-fetches the gap since its last known message
   * and merges it, deduping by id. Honours the caller's `clearedAt` floor just
   * like the backward path, so a cleared conversation never resurrects history.
   */
  private async getMessagesSince(
    conversationId: string,
    userId: string,
    clearedAt: Date | null,
    after: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<MessageResponse[]> {
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :id', { id: conversationId });
    if (clearedAt) {
      qb.andWhere('m.created_at > :clearedAt', {
        clearedAt: clearedAt.toISOString(),
      });
    }
    if (afterId) {
      qb.andWhere(
        '(m.created_at, m.id) > (:after::timestamptz, :afterId::uuid)',
        { after, afterId },
      );
    } else {
      qb.andWhere('m.created_at > :after', { after });
    }
    const rows = await qb
      .withDeleted()
      .orderBy('m.created_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .take(limit)
      .getMany();
    return this.toMessageResponses(rows, userId);
  }

  /**
   * Cross-conversation full-text-ish search over the caller's own messages.
   *
   * Server-authoritative on every axis the spec requires:
   *  - **Participation:** an `INNER JOIN` to the caller's own participant row
   *    (`p.user_id = :userId`) means only messages in conversations the caller
   *    belongs to are ever considered — there is no way to widen it from the
   *    request.
   *  - **`clearedAt` flooring:** the same joined row carries the caller's clear
   *    point; `(p.cleared_at IS NULL OR m.created_at > p.cleared_at)` hides
   *    anything at-or-before it, identical to `getMessages`' history floor, so a
   *    "deleted for me" thread never resurfaces through search.
   *  - **Tombstone exclusion:** no `.withDeleted()`, so the `@DeleteDateColumn`
   *    default filter drops soft-deleted rows — a deleted body is never a hit.
   *
   * Matching is a case-insensitive substring (`ILIKE %term%`) with the term's
   * LIKE metacharacters escaped and the pattern passed as a bound parameter
   * (injection-safe). This is a deliberate ILIKE-only MVP with NO new index/
   * migration: a single member's DM corpus is small and already narrowed to
   * their conversations by the participant join (which rides the existing
   * `messages (conversation_id, …)` index), so a scan of that subset is cheap.
   * A `pg_trgm`/`tsvector` GIN index is the right upgrade if per-member volume
   * ever grows — added then as a migration after `1785000800000`.
   *
   * Results are newest-first, capped at `limit`, and hand-mapped to
   * `MessageSearchResponse` (snippet + sender + timestamp per hit, plus the
   * per-conversation grouping metadata the client renders under each thread).
   */
  async searchMessages(
    userId: string,
    rawQuery: string,
    limit?: number,
  ): Promise<MessageSearchResponse> {
    const query = rawQuery.trim();
    const cappedLimit = Math.min(
      limit ?? DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    if (!query) {
      return { query, hits: [], conversations: [] };
    }
    const pattern = `%${escapeLikeTerm(query)}%`;
    const rows = await this.messages
      .createQueryBuilder('m')
      // Participation gate: only messages in conversations THIS user belongs to.
      // The join predicate — not a WHERE the caller could influence — is what
      // scopes the search, so it can't be widened from the request.
      .innerJoin(
        ConversationParticipant,
        'p',
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        { userId },
      )
      .where('m.body ILIKE :pattern', { pattern })
      // clearedAt floor: at-or-before the caller's clear point does not exist
      // for them (mirrors getMessages' history floor).
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // No `.withDeleted()`: the @DeleteDateColumn default filter drops
      // soft-deleted rows, so tombstoned bodies are never returned.
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(cappedLimit)
      .getMany();

    if (!rows.length) {
      return { query, hits: [], conversations: [] };
    }

    const conversationIds = [...new Set(rows.map((m) => m.conversationId))];
    const senderIds = [...new Set(rows.map((m) => m.senderId))];
    // Batch: the conversations (for isOfficial), every non-caller participant
    // (the counterpart per conversation), and the profiles for both those
    // counterparts and the hit senders — three queries, no per-row lookups.
    const [convos, others] = await Promise.all([
      this.conversations.find({ where: { id: In(conversationIds) } }),
      this.participants.find({
        where: { conversationId: In(conversationIds), userId: Not(userId) },
      }),
    ]);
    const convoById = new Map(convos.map((c) => [c.id, c]));
    const otherByConvo = new Map<string, ConversationParticipant>();
    for (const other of others) {
      // A 1:1 DM has exactly one counterpart; for an official/group thread the
      // first is fine — `isOfficial` below nulls the counterpart out anyway.
      if (!otherByConvo.has(other.conversationId)) {
        otherByConvo.set(other.conversationId, other);
      }
    }
    const profiles = await this.profiles.find({
      where: { userId: In([...senderIds, ...others.map((o) => o.userId)]) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

    const conversations: MessageSearchConversationGroup[] = conversationIds.map(
      (conversationId) => {
        const convo = convoById.get(conversationId);
        const isOfficial = Boolean(convo?.isOfficial);
        const other = otherByConvo.get(conversationId);
        return {
          conversationId,
          otherParticipant: isOfficial
            ? null
            : toAuthorSummary(other ? profileByUser.get(other.userId) : null),
          isOfficial,
        };
      },
    );

    const hits = rows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      snippet: buildSearchSnippet(m.body, query),
      sender: requireAuthorSummary(profileByUser.get(m.senderId)),
      createdAt: m.createdAt.toISOString(),
    }));

    return { query, hits, conversations };
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
    const [senders, reactionsByMessage, otherParticipantRows, pinRows, starRows] =
      await Promise.all([
        this.profiles.find({ where: { userId: In(senderIds) } }),
        this.reactionSummariesByMessage(messageIds, viewerId),
        this.participants.find({
          where: { conversationId, userId: Not(viewerId) },
        }),
        // Shared pins for these messages (viewer-agnostic — both participants
        // see the same pinnedAt) and THIS viewer's private stars, batched by id.
        this.pins.find({ where: { messageId: In(messageIds) } }),
        this.stars.find({ where: { userId: viewerId, messageId: In(messageIds) } }),
      ]);
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
      // A soft-deleted row renders as a tombstone: id/sender/createdAt are
      // kept (so the thread still shows who/when), but `body` and
      // `reactions` are blanked rather than leaking the deleted content.
      const isDeleted = Boolean(m.deletedAt);
      // Delivered only applies to the viewer's OWN outgoing messages (the only
      // side that renders a delivery tick), and only once the recipient's
      // watermark has reached this message. The watermark ISO is a truthful
      // upper bound on the arrival time.
      const delivered =
        m.senderId === viewerId &&
        otherDeliveredAt !== null &&
        m.createdAt <= otherDeliveredAt;
      return {
        id: m.id,
        conversationId: m.conversationId,
        body: isDeleted ? '' : m.body,
        sender: requireAuthorSummary(profileByUser.get(m.senderId)),
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        reactions: isDeleted ? [] : (reactionsByMessage.get(m.id) ?? []),
        deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        deliveredAt: delivered ? otherDeliveredAt!.toISOString() : null,
        clientMessageId: m.clientMessageId,
        forwarded: m.forwarded,
        // A tombstone carries no pin/star affordance; otherwise expose the shared
        // pin timestamp, this viewer's private star, and whether they may pin.
        pinnedAt: isDeleted
          ? null
          : (pinnedAtByMessage.get(m.id)?.toISOString() ?? null),
        starred: isDeleted ? false : starredMessageIds.has(m.id),
        canPin: !isDeleted,
        replyTo: buildReplyTo(m.replyToId, parentById, profileByUser),
        // Timeline kind + resolved system event. A `user` message carries a null
        // event; a `system` one resolves actor/target ids to display names so the
        // client renders bilingual templates ("You created the group", "Ana
        // added Bea") without ever seeing a user id.
        kind: m.kind === MessageKind.System ? 'system' : 'user',
        systemEvent:
          m.kind === MessageKind.System
            ? buildSystemEvent(m.systemEvent, profileByUser)
            : null,
      };
    });
  }

  async sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
  ): Promise<MessageResponse> {
    const participant = await this.requireParticipant(conversationId, userId);
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo) {
      throw new NotFoundException('Conversation not found');
    }
    // A member who LEFT a group keeps read access to history but cannot post.
    if (convo.kind === ConversationKind.Group && participant.leftAt) {
      throw new ForbiddenException('You have left this group');
    }
    // The 1:1 connection gate applies only to DIRECT member DMs — a group's
    // membership was validated at creation (and Phase 2 owns per-member gates),
    // and official threads are exempt. Picking an arbitrary "other" in a group
    // would wrongly gate on a single member.
    if (convo.kind !== ConversationKind.Group && !convo.isOfficial) {
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
    // `postMessage` is the single write path; it hydrates the frontend-contract
    // response once (reused here and in the MESSAGE_CREATED broadcast) and
    // dedupes on `clientMessageId` so a retry / dual HTTP+WS write can't
    // duplicate.
    const { response } = await this.postMessage(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
    );
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
    // Read implies delivered, so advance the delivered watermark in the same
    // write — a reader who opens the thread (and never sent an explicit socket
    // ack) still lets the sender see at least a "delivered" tick, and the two
    // watermarks can never cross (delivered can't lag read for the same view).
    await this.participants.update(
      { conversationId, userId },
      { lastReadAt: () => 'now()', deliveredAt: () => 'now()' },
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
    // No separate MESSAGE_DELIVERED here: the read frame already advances the
    // sender to "seen", which outranks "delivered" — a delivered frame would be
    // immediately superseded. The delivered watermark is bumped only so the DTO
    // (`otherDeliveredAt` / per-message `deliveredAt`) stays consistent on the
    // next fetch.
    return { ok: true };
  }

  /**
   * Record that `userId`'s device has RECEIVED everything in the conversation up
   * to now() — the "delivered" (double-check) signal, one rung below read. The
   * recipient's client acks this over the socket (throttled/batched) as inbound
   * messages arrive, or it rides in on `markRead` above. Advancing the watermark
   * is monotonic-in-practice (now() only moves forward) and idempotent, so a
   * batch of acks collapses to one meaningful stamp. Emits MESSAGE_DELIVERED so
   * the SENDER's live sockets flip their tick from one check to two.
   */
  async markDelivered(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { deliveredAt: () => 'now()' },
    );
    const updated = await this.participants.findOne({
      where: { conversationId, userId },
    });
    const deliveredAt = updated?.deliveredAt ?? new Date();
    this.eventEmitter.emit(MESSAGE_DELIVERED, {
      conversationId,
      userId,
      deliveredAt,
    } satisfies MessageDeliveredEvent);
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
      userId,
      reactions: await this.reactionCountsForMessage(messageId),
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
      userId,
      reactions: await this.reactionCountsForMessage(messageId),
    } satisfies MessageReactionEvent);
    return { ok: true };
  }

  /**
   * Authoritative per-key counts for one message (viewer-agnostic — no `mine`),
   * for the `reaction` event so live clients patch counts in place rather than
   * refetching the thread. Emits every key (including count 0) so a client can
   * SET each chip absolutely and clear a key that just dropped to zero. One row
   * per (message,user,key), so a plain `count(*)` grouped by key is exact.
   */
  private async reactionCountsForMessage(
    messageId: string,
  ): Promise<MessageReactionCount[]> {
    const rows = await this.reactions
      .createQueryBuilder('reaction')
      .select('reaction.key', 'key')
      .addSelect('COUNT(*)', 'count')
      .where('reaction.message_id = :messageId', { messageId })
      .groupBy('reaction.key')
      .getRawMany<{ key: MessageReactionKey; count: string }>();
    const countByKey = new Map(rows.map((row) => [row.key, Number(row.count)]));
    return Object.values(MessageReactionKey).map((key) => ({
      key,
      count: countByKey.get(key) ?? 0,
    }));
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
    // invariant: toMessageResponses returns one response per input view, and
    // exactly one view was passed in.
    return response!;
  }

  // ── Pins (SHARED, per-conversation) ────────────────────────────────────────

  /**
   * Pin a message in a conversation. SHARED: either participant may pin, both
   * see it. Idempotent — `ON CONFLICT DO NOTHING` on UNIQUE(conversation,
   * message) absorbs a re-pin (or a race) without a 23505. Records the pinner.
   * `requireMessageInConversation` rejects a message that isn't in this thread
   * or has been (soft-)deleted, so a tombstone can't be pinned. Emits
   * MESSAGE_PINNED so both participants' banners update live.
   */
  async pinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.requireMessageInConversation(conversationId, messageId);
    await this.pins
      .createQueryBuilder()
      .insert()
      .into(ConversationPinnedMessage)
      .values({ conversationId, messageId, pinnedBy: userId })
      .orIgnore()
      .execute();
    this.eventEmitter.emit(MESSAGE_PINNED, {
      conversationId,
      messageId,
      pinned: true,
    } satisfies MessagePinnedEvent);
    return { ok: true };
  }

  /**
   * Unpin a message. SHARED (either participant may unpin). Idempotent — a
   * delete of a non-existent pin is a no-op success. Emits MESSAGE_PINNED so
   * both participants' banners update live.
   */
  async unpinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.pins.delete({ conversationId, messageId });
    this.eventEmitter.emit(MESSAGE_PINNED, {
      conversationId,
      messageId,
      pinned: false,
    } satisfies MessagePinnedEvent);
    return { ok: true };
  }

  /**
   * The conversation's pinned messages, newest-pin-first, as full
   * `MessageResponse`s (so the banner has body/sender/pinnedAt and can jump to
   * the original). Floored by the caller's `clearedAt` and excluding
   * soft-deleted messages — a pin whose message was cleared/deleted simply drops
   * out of the banner (the DB row lingers harmlessly until the message is hard
   * deleted, which cascades it away).
   */
  async listPinnedMessages(
    conversationId: string,
    userId: string,
  ): Promise<MessageResponse[]> {
    const participant = await this.requireParticipant(conversationId, userId);
    const pinRows = await this.pins.find({
      where: { conversationId },
      order: { pinnedAt: 'DESC' },
    });
    if (!pinRows.length) {
      return [];
    }
    const messages = await this.messages.find({
      where: { id: In(pinRows.map((pin) => pin.messageId)) },
    });
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const ordered: Message[] = [];
    for (const pin of pinRows) {
      const message = messageById.get(pin.messageId);
      // Drop a pin whose message is gone (soft-deleted / hard-removed) or falls
      // at-or-before the caller's clear floor — it doesn't exist for them.
      if (!message) continue;
      if (participant.clearedAt && message.createdAt <= participant.clearedAt) {
        continue;
      }
      ordered.push(message);
    }
    return this.toMessageResponses(ordered, userId);
  }

  // ── Stars (PRIVATE, per-user bookmark) ─────────────────────────────────────

  /**
   * Star (bookmark) a message for THIS user only. Idempotent per (user,
   * message). Private by construction — no event is emitted and no other
   * participant can observe it. `requireMessageInConversation` rejects a
   * message not in this thread or soft-deleted.
   */
  async starMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.requireMessageInConversation(conversationId, messageId);
    await this.stars
      .createQueryBuilder()
      .insert()
      .into(MessageStar)
      .values({ userId, messageId })
      .orIgnore()
      .execute();
    return { ok: true };
  }

  /** Remove this user's star. Idempotent. Private. */
  async unstarMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.requireParticipant(conversationId, userId);
    await this.stars.delete({ userId, messageId });
    return { ok: true };
  }

  /**
   * The caller's starred messages, newest-star-first, for the "Starred messages"
   * view. Scoped to the caller by construction (the star join is on
   * `user_id = :userId`), floored by their `clearedAt`, and excluding
   * soft-deleted messages — mirrors `searchMessages`' guards. Returns each hit
   * plus the per-conversation grouping metadata the client renders/jumps with.
   */
  async listStarredMessages(
    userId: string,
    limit?: number,
  ): Promise<StarredMessagesResponse> {
    const cappedLimit = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    // Order by star recency via the join; hydrate the exact `starredAt` in a
    // second batched query (avoids fragile raw-alias parsing).
    const messages = await this.messages
      .createQueryBuilder('m')
      .innerJoin(MessageStar, 's', 's.message_id = m.id AND s.user_id = :userId', {
        userId,
      })
      // Participation + clearedAt floor: the caller's own participant row for the
      // message's conversation. A star can only exist for a message they could
      // see, but this also enforces the clear floor after a "delete for me".
      .innerJoin(
        ConversationParticipant,
        'p',
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        { userId },
      )
      .where('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // No `.withDeleted()`: the @DeleteDateColumn default filter drops tombstones.
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      // `.limit()`, not `.take()`: ordering by the joined alias `s.created_at`
      // trips TypeORM's distinct-pagination strategy (which `.take()` enables
      // whenever joins are present), and that path can't resolve column
      // metadata for a non-selected join alias — it dereferences
      // `undefined.databaseName` and throws. Neither join multiplies rows
      // (MessageStar is UNIQUE(user, message); the participant join is unique
      // per (conversation, user)), so a plain SQL LIMIT is exactly equivalent.
      .limit(cappedLimit)
      .getMany();

    if (!messages.length) {
      return { items: [], conversations: [] };
    }
    const starRows = await this.stars.find({
      where: { userId, messageId: In(messages.map((m) => m.id)) },
    });
    const starredAtById = new Map(
      starRows.map((star) => [star.messageId, star.createdAt.toISOString()]),
    );

    const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const [convos, others] = await Promise.all([
      this.conversations.find({ where: { id: In(conversationIds) } }),
      this.participants.find({
        where: { conversationId: In(conversationIds), userId: Not(userId) },
      }),
    ]);
    const convoById = new Map(convos.map((c) => [c.id, c]));
    const otherByConvo = new Map<string, ConversationParticipant>();
    for (const other of others) {
      if (!otherByConvo.has(other.conversationId)) {
        otherByConvo.set(other.conversationId, other);
      }
    }
    const profiles = await this.profiles.find({
      where: { userId: In([...senderIds, ...others.map((o) => o.userId)]) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

    const conversations: MessageSearchConversationGroup[] = conversationIds.map(
      (conversationId) => {
        const convo = convoById.get(conversationId);
        const isOfficial = Boolean(convo?.isOfficial);
        const other = otherByConvo.get(conversationId);
        return {
          conversationId,
          otherParticipant: isOfficial
            ? null
            : toAuthorSummary(other ? profileByUser.get(other.userId) : null),
          isOfficial,
        };
      },
    );

    const items: StarredMessageHit[] = messages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      snippet: m.body.slice(0, 160),
      sender: requireAuthorSummary(profileByUser.get(m.senderId)),
      createdAt: m.createdAt.toISOString(),
      starredAt: starredAtById.get(m.id) ?? m.createdAt.toISOString(),
    }));

    return { items, conversations };
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

  /**
   * `POST /conversations/group` — create a group thread. The caller becomes its
   * `owner` participant; each resolved member joins as `member`. Members are
   * addressed by their profile HANDLE (slug — the same identifier the DM start
   * uses), resolved to user ids here. Every prospective member is gated exactly
   * like a DM: a block either way is a hard stop, and the pair must be accepted
   * connections. Seeds a `group_created` system message and fans the new group
   * to every member's socket room so their inbox refreshes live.
   */
  async createGroup(
    userId: string,
    title: string,
    memberHandles: string[],
    avatarUrl?: string,
  ): Promise<ConversationResponse> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new BadRequestException('A group needs a name');
    }
    const uniqueHandles = [
      ...new Set(memberHandles.map((handle) => handle.trim()).filter(Boolean)),
    ];
    if (!uniqueHandles.length) {
      throw new BadRequestException('A group needs at least one other member');
    }
    const profiles = await this.profiles.find({
      where: { slug: In(uniqueHandles) },
    });
    const profileByHandle = new Map(profiles.map((p) => [p.slug, p]));
    const memberUserIds: string[] = [];
    for (const handle of uniqueHandles) {
      const profile = profileByHandle.get(handle);
      if (!profile) {
        throw new NotFoundException(`Member not found: ${handle}`);
      }
      // Silently ignore the creator if they included themselves.
      if (profile.userId === userId) {
        continue;
      }
      if (await this.blockFilter.isBlockedEitherWay(userId, profile.userId)) {
        throw new ForbiddenException(
          'You cannot add a member you have blocked (or who has blocked you)',
        );
      }
      if (!(await this.connectionsService.areConnected(userId, profile.userId))) {
        throw new ForbiddenException(
          'You can only add accepted connections to a group',
        );
      }
      if (!memberUserIds.includes(profile.userId)) {
        memberUserIds.push(profile.userId);
      }
    }
    if (!memberUserIds.length) {
      throw new BadRequestException('A group needs at least one other member');
    }

    const conversation = await this.dataSource.transaction(async (manager) => {
      const convo = await manager.save(
        manager.create(Conversation, {
          kind: ConversationKind.Group,
          isOfficial: false,
          pairKey: null,
          title: trimmedTitle,
          avatarUrl: avatarUrl ?? null,
          createdBy: userId,
        }),
      );
      await manager.save([
        manager.create(ConversationParticipant, {
          conversationId: convo.id,
          userId,
          role: ConversationRole.Owner,
        }),
        ...memberUserIds.map((memberId) =>
          manager.create(ConversationParticipant, {
            conversationId: convo.id,
            userId: memberId,
            role: ConversationRole.Member,
          }),
        ),
      ]);
      return convo;
    });

    // Seed the opening system message (actor = creator). `body` is a plain-text
    // fallback; the client renders the structured event as a centred pill.
    await this.postSystemMessage(conversation.id, {
      type: 'group_created',
      actorId: userId,
    });

    // The members were not in the conversation room when it was created, so a
    // room-scoped `message:new` won't reach them — fan the new group to each
    // member's `user:<id>` room so their inbox refetches live.
    this.eventEmitter.emit(CONVERSATION_CREATED, {
      conversationId: conversation.id,
      memberUserIds: [userId, ...memberUserIds],
    } satisfies ConversationCreatedEvent);

    return this.toGroupConversationResponse(conversation, userId);
  }

  /**
   * `POST /conversations/:id/leave` — the caller leaves a GROUP. Stamps their
   * `left_at` (KEEPING the row for history + identity resolution), seeds a
   * `member_left` system message, and broadcasts it to the room. Idempotent: a
   * repeat leave is a no-op success. Adding/removing OTHERS and role changes are
   * Phase 2 — this only covers the foundational self-leave.
   */
  async leaveGroup(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    const participant = await this.requireParticipant(conversationId, userId);
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo || convo.kind !== ConversationKind.Group) {
      throw new BadRequestException('This is not a group conversation');
    }
    if (participant.leftAt) {
      return { ok: true };
    }
    participant.leftAt = new Date();
    await this.participants.save(participant);
    await this.postSystemMessage(conversationId, {
      type: 'member_left',
      actorId: userId,
    });
    // Owner succession: an owner who leaves hands ownership to the
    // longest-standing remaining member. Participant rows carry no join
    // timestamp, so "longest-standing" is approximated deterministically — an
    // existing admin before a plain member, ties broken by participant id (a
    // stable rule, documented in group-chat.md). If nobody remains, the group is
    // left ownerless (no dissolve — matches Phase 1's "no cleanup" decision).
    if (participant.role === ConversationRole.Owner) {
      await this.promoteSuccessor(conversationId, userId);
    }
    return { ok: true };
  }

  /**
   * `POST /conversations/:id/members` — owner/admin adds members by HANDLE. Each
   * prospective member is gated exactly like a DM/create (block either way → 403,
   * not an accepted connection of the ADDER → 403); an already-active member is
   * skipped, and a previously-removed/left member's row is REACTIVATED (role reset
   * to member, `left_at`/`cleared_at` cleared so they see history again). Posts a
   * `member_added` pill per add and fans the group to each new member's user room.
   * SERVER-AUTHORITATIVE: the caller's role is re-checked here, not trusted.
   */
  async addMembers(
    conversationId: string,
    actorUserId: string,
    memberHandles: string[],
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    const uniqueHandles = [
      ...new Set(memberHandles.map((handle) => handle.trim()).filter(Boolean)),
    ];
    if (!uniqueHandles.length) {
      throw new BadRequestException('Pick at least one member to add');
    }
    const profiles = await this.profiles.find({
      where: { slug: In(uniqueHandles) },
    });
    const profileByHandle = new Map(profiles.map((p) => [p.slug, p]));
    const existingRows = await this.participants.find({
      where: { conversationId },
    });
    const rowByUser = new Map(existingRows.map((row) => [row.userId, row]));
    const addedUserIds: string[] = [];
    for (const handle of uniqueHandles) {
      const profile = profileByHandle.get(handle);
      if (!profile) {
        throw new NotFoundException(`Member not found: ${handle}`);
      }
      if (profile.userId === actorUserId) {
        continue;
      }
      const existing = rowByUser.get(profile.userId);
      if (existing && existing.leftAt == null) {
        continue; // already an active member — silently skip
      }
      if (await this.blockFilter.isBlockedEitherWay(actorUserId, profile.userId)) {
        throw new ForbiddenException(
          'You cannot add a member you have blocked (or who has blocked you)',
        );
      }
      if (
        !(await this.connectionsService.areConnected(actorUserId, profile.userId))
      ) {
        throw new ForbiddenException(
          'You can only add accepted connections to a group',
        );
      }
      if (existing) {
        existing.leftAt = null;
        existing.role = ConversationRole.Member;
        existing.clearedAt = null;
        await this.participants.save(existing);
      } else {
        await this.participants.save(
          this.participants.create({
            conversationId,
            userId: profile.userId,
            role: ConversationRole.Member,
          }),
        );
      }
      if (!addedUserIds.includes(profile.userId)) {
        addedUserIds.push(profile.userId);
      }
    }
    if (!addedUserIds.length) {
      throw new BadRequestException('No new members to add');
    }
    for (const targetId of addedUserIds) {
      await this.postSystemMessage(conversationId, {
        type: 'member_added',
        actorId: actorUserId,
        targetId,
      });
    }
    this.eventEmitter.emit(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds: addedUserIds,
    } satisfies ConversationCreatedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `DELETE /conversations/:id/members/:userId` — owner/admin removes a member.
   * The owner can never be removed; an admin may remove members but only the
   * owner may remove another admin. Sets the target's `left_at` (row kept for
   * history + identity), posts a `member_removed` pill (relayed to the room), and
   * fans a refetch to the removed member's user room so their client reflects the
   * departure (read-only history retained, like a voluntary leave).
   * SERVER-AUTHORITATIVE role re-check.
   */
  async removeMember(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<ConversationResponse> {
    const { participant: actor, convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    if (targetUserId === actorUserId) {
      throw new BadRequestException('Use leave to remove yourself');
    }
    const target = await this.participants.findOne({
      where: { conversationId, userId: targetUserId },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    if (target.role === ConversationRole.Owner) {
      throw new ForbiddenException('The group owner cannot be removed');
    }
    // Admins manage members; only the owner acts on other admins.
    if (
      target.role === ConversationRole.Admin &&
      actor.role !== ConversationRole.Owner
    ) {
      throw new ForbiddenException('Only the owner can remove an admin');
    }
    target.leftAt = new Date();
    await this.participants.save(target);
    await this.postSystemMessage(conversationId, {
      type: 'member_removed',
      actorId: actorUserId,
      targetId: targetUserId,
    });
    this.eventEmitter.emit(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds: [targetUserId],
    } satisfies ConversationCreatedEvent);
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id/members/:userId/role` — OWNER ONLY. Promotes a
   * member→admin or demotes an admin→member (the `owner` role can't be assigned
   * here — succession is separate). Quiet (no pill); fans a refetch so every
   * member's role badges + can-flags update live. SERVER-AUTHORITATIVE.
   */
  async changeMemberRole(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
    role: ConversationRole,
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Owner,
    );
    if (role !== ConversationRole.Admin && role !== ConversationRole.Member) {
      throw new BadRequestException('Role must be admin or member');
    }
    if (targetUserId === actorUserId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.participants.findOne({
      where: { conversationId, userId: targetUserId },
    });
    if (!target || target.leftAt) {
      throw new NotFoundException('That member is not in this group');
    }
    if (target.role === ConversationRole.Owner) {
      throw new ForbiddenException('The owner role cannot be changed here');
    }
    if (target.role !== role) {
      target.role = role;
      await this.participants.save(target);
      await this.fanGroupRefresh(conversationId);
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * `PATCH /conversations/:id` (title/avatar) — owner/admin edits the group's
   * name and/or photo. A title change posts a `group_renamed` pill (relayed to
   * the room); an avatar-only change fans a quiet refetch. `avatarUrl` reuses the
   * storage-key plumbing already threaded end-to-end (no new upload pipeline is
   * built here — see the group-chat note). SERVER-AUTHORITATIVE role re-check.
   */
  async updateGroup(
    conversationId: string,
    actorUserId: string,
    changes: { title?: string; avatarUrl?: string | null },
  ): Promise<ConversationResponse> {
    const { convo } = await this.requireGroupRole(
      conversationId,
      actorUserId,
      ConversationRole.Admin,
    );
    let renamed = false;
    if (changes.title !== undefined) {
      const trimmed = changes.title.trim();
      if (!trimmed) {
        throw new BadRequestException('A group needs a name');
      }
      if (trimmed !== convo.title) {
        convo.title = trimmed;
        renamed = true;
      }
    }
    let avatarChanged = false;
    if (changes.avatarUrl !== undefined) {
      const next = changes.avatarUrl || null;
      if (next !== convo.avatarUrl) {
        convo.avatarUrl = next;
        avatarChanged = true;
      }
    }
    if (renamed || avatarChanged) {
      await this.conversations.save(convo);
    }
    if (renamed) {
      await this.postSystemMessage(conversationId, {
        type: 'group_renamed',
        actorId: actorUserId,
        value: convo.title ?? undefined,
      });
    } else if (avatarChanged) {
      await this.fanGroupRefresh(conversationId);
    }
    return this.toGroupConversationResponse(convo, actorUserId);
  }

  /**
   * Server-authoritative group role gate. Loads the caller's participant row +
   * the conversation, asserts it's a group they still belong to (not left), and
   * that their role meets `minRole` in owner > admin > member order. EVERY
   * management mutation calls this first; the DTO's can-flags are never trusted.
   */
  private async requireGroupRole(
    conversationId: string,
    userId: string,
    minRole: ConversationRole,
  ): Promise<{ participant: ConversationParticipant; convo: Conversation }> {
    const participant = await this.requireParticipant(conversationId, userId);
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!convo || convo.kind !== ConversationKind.Group) {
      throw new BadRequestException('This is not a group conversation');
    }
    if (participant.leftAt) {
      throw new ForbiddenException('You have left this group');
    }
    if (ROLE_RANK[participant.role] > ROLE_RANK[minRole]) {
      throw new ForbiddenException('You do not have permission to do that');
    }
    return { participant, convo };
  }

  /**
   * Promote the successor when an owner leaves: the highest-ranked remaining
   * active member (an existing admin before a plain member), ties broken
   * deterministically by participant id. No-op if nobody remains (group left
   * ownerless). Fans a quiet refetch so members see the new owner badge.
   */
  private async promoteSuccessor(
    conversationId: string,
    leavingUserId: string,
  ): Promise<void> {
    const rows = await this.participants.find({ where: { conversationId } });
    const [successor] = rows
      .filter((row) => row.leftAt == null && row.userId !== leavingUserId)
      .sort(
        (a, b) =>
          ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.id.localeCompare(b.id),
      );
    if (!successor) {
      return;
    }
    successor.role = ConversationRole.Owner;
    await this.participants.save(successor);
    await this.fanGroupRefresh(conversationId);
  }

  /**
   * Fan a `conversation:new` (inbox refetch) to every ACTIVE member's user room —
   * for group mutations that post no system message (role change, avatar-only
   * edit, succession) so every member's roster/can-flags/photo refresh live.
   */
  private async fanGroupRefresh(conversationId: string): Promise<void> {
    const rows = await this.participants.find({ where: { conversationId } });
    const memberUserIds = rows
      .filter((row) => row.leftAt == null)
      .map((row) => row.userId);
    if (!memberUserIds.length) {
      return;
    }
    this.eventEmitter.emit(CONVERSATION_CREATED, {
      conversationId,
      memberUserIds,
    } satisfies ConversationCreatedEvent);
  }

  /**
   * Persist a `system` message and broadcast it (via `buildPostResult` →
   * MESSAGE_CREATED → the gateway's `message:new`). The event's `actorId` is the
   * message's sender, so the actor's profile is already batch-loaded when the
   * DTO resolves the event to display names. `body` is a plain-text fallback for
   * consumers that don't understand the structured event.
   */
  private async postSystemMessage(
    conversationId: string,
    event: SystemEvent,
  ): Promise<MessageResponse> {
    const saved = await this.messages.save(
      this.messages.create({
        conversationId,
        senderId: event.actorId,
        body: SYSTEM_EVENT_FALLBACK[event.type],
        kind: MessageKind.System,
        systemEvent: event,
      }),
    );
    const { response } = await this.buildPostResult(saved, event.actorId, true);
    return response;
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
        ? this.buildLastMessagePreview(
            clearedLastMessage,
            convo.id,
            profileByUser,
            reactionsByMessage.get(clearedLastMessage.id) ?? [],
          )
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      otherLastReadAt: otherParticipantRow?.lastReadAt?.toISOString() ?? null,
      otherDeliveredAt: otherParticipantRow?.deliveredAt?.toISOString() ?? null,
      otherParticipantId: otherParticipantRow?.userId ?? null,
      // DM: the group-only fields carry their empty defaults so the DTO shape is
      // uniform. The client's DM path never reads them.
      kind: 'direct',
      title: null,
      avatarUrl: null,
      memberCount: 0,
      members: [],
    };
  }

  /**
   * Builds the frontend-contract `ConversationResponse` for a GROUP thread —
   * `otherParticipant`/counterpart watermarks are null (a group has no single
   * counterpart), and it instead carries the title, group avatar, active
   * member roster, and this caller's left/muted state. Returned by
   * `createGroup` and reused after a group mutation.
   */
  private async toGroupConversationResponse(
    convo: Conversation,
    userId: string,
  ): Promise<ConversationResponse> {
    const [participantRows, lastByConvo, unreadByConvo] = await Promise.all([
      this.participants.find({ where: { conversationId: convo.id } }),
      this.lastMessagesByConversation([convo.id]),
      this.unreadCountsByConversation([convo.id], userId),
    ]);
    const callerRow = participantRows.find((row) => row.userId === userId);
    const profiles = await this.profiles.find({
      where: { userId: In(participantRows.map((row) => row.userId)) },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const members = this.buildMemberSummaries(participantRows, profileByUser);

    const lastMessage = lastByConvo.get(convo.id) ?? null;
    const clearedAt = callerRow?.clearedAt ?? null;
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
      type: 'group',
      otherParticipant: null,
      lastMessage: clearedLastMessage
        ? this.buildLastMessagePreview(
            clearedLastMessage,
            convo.id,
            profileByUser,
            reactionsByMessage.get(clearedLastMessage.id) ?? [],
          )
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      otherLastReadAt: null,
      otherDeliveredAt: null,
      otherParticipantId: null,
      kind: 'group',
      title: convo.title,
      avatarUrl: toImageUrl(convo.avatarUrl),
      memberCount: members.length,
      members,
      isOfficial: false,
      muted: callerRow?.muted ?? false,
      hasLeft: callerRow?.leftAt != null,
      ...this.groupCapabilities(callerRow?.role, callerRow?.leftAt != null),
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
      const { view } = await this.postMessage(conversation.id, userId, body);
      return {
        conversationId: conversation.id,
        message: view,
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
  private async postMessage(
    conversationId: string,
    senderId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
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
  private async buildPostResult(
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
