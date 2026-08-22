import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { decodeCursor } from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { GifAttachment, Message } from './entities/message.entity';
import {
  MessageResponse,
  MessageSearchConversationGroup,
  MessageSearchResponse,
  requireAuthorSummary,
  toAuthorSummary,
  toMessageView,
} from './message-response';
import {
  DEFAULT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_LIMIT,
  MAX_SEARCH_LIMIT,
  EDIT_WINDOW_MS,
} from './messaging.constants';
import {
  MESSAGE_DELETED,
  MESSAGE_UPDATED,
  MessageDeletedEvent,
  MessageUpdatedEvent,
} from './messaging.events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessagingCoreService } from './messaging-core.service';

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
 * Messages concern of the split `MessagingService`: thread history
 * (`getMessages`, keyset-paginated + reconnect "since" sync), cross-conversation
 * search, send, edit, and soft-delete. Conversation-level concerns (inbox,
 * mute, read/delivered watermarks, "delete for me") live in
 * `ConversationsService`; reactions/pins/stars live in
 * `MessageAnnotationsService`; group membership lives in `GroupsService`.
 *
 * Every read here goes through `MessagingCoreService.requireParticipant` for
 * the caller's `clearedAt` floor — never a locally re-derived copy.
 */
@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly eventEmitter: EventEmitter2,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly usersService: UsersService,
  ) {}

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
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
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
        participant.leftAt,
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
    if (participant.leftAt) {
      // P0 hardening: a removed/left group member's read access CEILINGS at
      // the moment they left — mirrors `clearedAt`'s floor but in the
      // opposite direction. Without this, a former member kept unbounded
      // read access to everything posted after their departure.
      qb.andWhere('m.created_at <= :leftAt', {
        leftAt: participant.leftAt.toISOString(),
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
        // Legacy single-column cursor (`before` with no `beforeId`). It has to
        // be INCLUSIVE: several messages routinely share one millisecond (a
        // burst send, or the system pills `GroupsService` inserts in a single
        // transaction), and a strict `<` silently dropped every message that
        // shared the boundary instant with the client's oldest known row. An
        // inclusive bound can only ever REPEAT the boundary message, which
        // every client already absorbs (history pages are merged by message
        // id). Pass `beforeId` too for the exact composite keyset above.
        qb.andWhere('m.created_at <= :before', { before });
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
    return this.core.toMessageResponses(rows, userId);
  }

  /**
   * Messages strictly newer than the `(after, afterId)` keyset, oldest→newest,
   * capped at `limit`. Backs reconnect history sync: after a socket drop (which
   * buffers nothing) the client re-fetches the gap since its last known message
   * and merges it, deduping by id. Honours the caller's `clearedAt` floor AND
   * `leftAt` ceiling just like the backward path, so a cleared conversation
   * never resurrects history and a left/removed group member can't use
   * reconnect-sync to read past their departure.
   */
  private async getMessagesSince(
    conversationId: string,
    userId: string,
    clearedAt: Date | null,
    leftAt: Date | null,
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
    if (leftAt) {
      // P0 hardening — see the matching comment in `getMessages`.
      qb.andWhere('m.created_at <= :leftAt', {
        leftAt: leftAt.toISOString(),
      });
    }
    if (afterId) {
      qb.andWhere(
        '(m.created_at, m.id) > (:after::timestamptz, :afterId::uuid)',
        { after, afterId },
      );
    } else {
      // Inclusive for the same reason as the backward cursor's fallback above:
      // without `afterId` a strict `>` skips every message sharing the boundary
      // millisecond, and reconnect sync merges by id so a repeat is free.
      qb.andWhere('m.created_at >= :after', { after });
    }
    const rows = await qb
      .withDeleted()
      .orderBy('m.created_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .take(limit)
      .getMany();
    return this.core.toMessageResponses(rows, userId);
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
    conversationId?: string,
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
      // Single-thread scope ("search in this chat", opened from an already-open
      // conversation) — additive on top of the participation join above, so a
      // conversation the caller isn't in still yields zero rows rather than
      // ever widening the search.
      .andWhere(
        conversationId ? 'm.conversation_id = :conversationId' : '1=1',
        conversationId ? { conversationId } : {},
      )
      // clearedAt floor: at-or-before the caller's clear point does not exist
      // for them (mirrors getMessages' history floor).
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // leftAt ceiling: the mirror of the floor above, and the same P0
      // hardening `getMessages`/`getMessagesSince` apply. Without it a member
      // removed from (or who left) a group could probe common terms through
      // `GET /messages/search` and read `buildSearchSnippet` windows of every
      // message posted AFTER their departure — reconstructing the thread the
      // history ceiling was added to withhold.
      .andWhere('(p.left_at IS NULL OR m.created_at <= p.left_at)')
      // Moderator-taken-down messages (hidden OR removed, keyed by the message
      // uuid) never surface as a search hit — the searcher is always an
      // ordinary participant here (never acting as staff), and a tombstoned
      // body is meaningless to match on. In-query NOT EXISTS so the capped page
      // isn't under-filled. `content_moderation.subject_id` is varchar while
      // `m.id` is uuid, hence the `::text` cast.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :messageSubjectType
            AND "cm"."subject_id" = m.id::text
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        )`,
        { messageSubjectType: 'message' },
      )
      // No `.withDeleted()`: the @DeleteDateColumn default filter drops
      // soft-deleted rows, so tombstoned bodies are never returned.
      // Property path (`createdAt`), not the raw column: the participation
      // `innerJoin` above + `.take()` engages TypeORM's distinct-id pagination
      // pass, which resolves ORDER BY via `findColumnWithPropertyPath` and
      // throws `undefined.databaseName` on a raw DB column name. (Sibling
      // `message-annotations` sidesteps the same trap with `.limit()`.)
      .orderBy('m.createdAt', 'DESC')
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

  async sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image',
    attachment?: GifAttachment,
  ): Promise<MessageResponse> {
    // Sending is the ONE messaging write both transports share (HTTP POST and
    // the gateway's `message:send`), so the sender's CURRENT account status is
    // asserted here rather than in either caller.
    //
    // The websocket path reads `status` from the JWT claim once, at the
    // handshake, and never again — so without this a member suspended or
    // banned by a moderator kept posting for the remaining life of their
    // 15-minute access token, which for a harassment suspension is exactly the
    // window that matters. HTTP is already covered by `JwtStrategy`'s
    // per-request row read; this makes the two agree and fails closed on a
    // deleted row. `ChatSessionEnforcementService` is the receive-side half:
    // it drops the offending sockets on its next sweep.
    const sender = await this.usersService.findById(userId);
    if (sender?.status !== UserStatus.Active) {
      throw new ForbiddenException('Your account cannot send messages');
    }
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
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
      if (other) {
        // P0 hardening: a `blocks` row is a hard stop even if the
        // `connections` edge somehow still reads Accepted (e.g. a stale read
        // racing `SocialService.blockMember`'s transactional sever) —
        // defense-in-depth, checked before (and independent of) the
        // connection gate below.
        if (await this.blockFilter.isBlockedEitherWay(userId, other.userId)) {
          throw new ForbiddenException('You cannot message this member');
        }
        if (
          !(await this.connectionsService.areConnected(userId, other.userId))
        ) {
          throw new ForbiddenException(
            'You can only message accepted connections',
          );
        }
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
    // `core.postMessage` is the single write path; it hydrates the
    // frontend-contract response once (reused here and in the MESSAGE_CREATED
    // broadcast) and dedupes on `clientMessageId` so a retry / dual HTTP+WS
    // write can't duplicate.
    const { response } = await this.core.postMessage(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
      kind,
      attachment,
    );
    return response;
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
    await this.core.requireParticipant(conversationId, userId);
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

    // Conditional soft-delete: only the row still un-deleted is tombstoned. Two
    // concurrent deletes both pass the `message.deletedAt` guard above, but the
    // `deleted_at IS NULL` predicate lets exactly ONE update affect a row — so
    // MESSAGE_DELETED is broadcast once, never on a repeat/no-op delete.
    const result = await this.messages
      .createQueryBuilder()
      .update(Message)
      .set({ deletedAt: () => 'now()' })
      .where('id = :messageId', { messageId })
      .andWhere('conversation_id = :conversationId', { conversationId })
      .andWhere('deleted_at IS NULL')
      .execute();

    if (result.affected === 1) {
      this.eventEmitter.emit(MESSAGE_DELETED, {
        conversationId,
        messageId,
      } satisfies MessageDeletedEvent);
    }
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
    // Active participation: an edit broadcasts a new body into the room, so a
    // member who left the group (or a blocked DM counterpart) must not be able
    // to push one (BE-MSG-09). `deleteMessage` deliberately keeps the lenient
    // check — removing your own content stays possible after you leave.
    await this.core.requireActiveParticipant(conversationId, userId);
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
    // A moderator takedown outranks the author's edit window. Reads already
    // tombstone a hidden/removed message, but editing it was still permitted:
    // the author of a just-hidden message could rewrite it inside the 15
    // minutes, changing what the moderator sees in the report, and the
    // `message:updated` frame carried the new body to every connected
    // participant — defeating the takedown on live clients.
    if (await this.core.isMessageTakenDown(messageId)) {
      throw new ForbiddenException('This message can no longer be edited');
    }
    message.body = body;
    message.editedAt = new Date();
    const saved = await this.messages.save(message);
    const view = toMessageView(saved);
    const [response] = await this.core.toMessageResponses([view], userId);
    // invariant: toMessageResponses returns one response per input view, and
    // exactly one view was passed in.
    // Broadcast the HYDRATED response, not the raw view: `toMessageResponses`
    // is what applies tombstoning, so the live frame can never carry a body
    // the read path would have withheld. (See `MessageUpdatedEvent`.)
    this.eventEmitter.emit(MESSAGE_UPDATED, {
      conversationId,
      message: response!,
    } satisfies MessageUpdatedEvent);
    return response!;
  }
}
