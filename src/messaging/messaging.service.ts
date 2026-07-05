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
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import {
  ConversationMemberView,
  ConversationSummary,
  MessageView,
  toConversationMemberView,
  toMessageView,
} from './message-response';
import {
  MESSAGE_CREATED,
  MESSAGE_READ,
  MessageCreatedEvent,
  MessageReadEvent,
} from './messaging.events';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

@Injectable()
export class MessagingService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly connectionsService: ConnectionsService,
  ) {}

  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const myParts = await this.participants.find({ where: { userId } });
    if (!myParts.length) {
      return [];
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
    const otherProfiles = await this.profiles.find({
      where: { userId: In(others.map((o) => o.userId)) },
    });
    const profileByUser = new Map(otherProfiles.map((p) => [p.userId, p]));

    // One query for the newest (non-deleted) message per conversation and one
    // grouped query for this user's unread counts — replaces the previous
    // per-conversation findOne + count (N+1).
    const [lastByConvo, unreadByConvo] = await Promise.all([
      this.lastMessagesByConversation(convoIds),
      this.unreadCountsByConversation(convoIds, userId),
    ]);

    const summaries: ConversationSummary[] = [];
    for (const part of myParts) {
      const convo = convoById.get(part.conversationId);
      if (!convo) {
        continue;
      }
      let otherMember: ConversationMemberView | null = null;
      if (!convo.isOfficial) {
        // 1:1 thread: the single counterpart. Official/welcome threads render
        // with no "other member" — the client shows the org identity.
        const first = othersByConvo.get(convo.id)?.[0];
        otherMember = toConversationMemberView(
          first ? profileByUser.get(first.userId) : undefined,
        );
      }
      const lastMessage = lastByConvo.get(convo.id) ?? null;
      summaries.push({
        id: convo.id,
        isOfficial: convo.isOfficial,
        otherMember,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              senderId: lastMessage.senderId,
              body: lastMessage.body,
              createdAt: lastMessage.createdAt,
            }
          : null,
        unreadCount: unreadByConvo.get(convo.id) ?? 0,
        muted: part.muted,
      });
    }
    // Most recently active first.
    summaries.sort((a, b) => {
      const at = a.lastMessage?.createdAt.getTime() ?? 0;
      const bt = b.lastMessage?.createdAt.getTime() ?? 0;
      return bt - at;
    });
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
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string; count: string }>();
    return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
  }

  async getMessages(
    conversationId: string,
    userId: string,
    opts: { before?: string; beforeId?: string; limit?: number },
  ): Promise<MessageView[]> {
    await this.requireParticipant(conversationId, userId);
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :id', { id: conversationId });
    if (opts.before) {
      if (opts.beforeId) {
        // Composite keyset cursor: strictly "older" than (before, beforeId) in
        // the (created_at DESC, id DESC) ordering, so messages sharing the same
        // millisecond as the page boundary are neither skipped nor duplicated.
        qb.andWhere(
          '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
          { before: opts.before, beforeId: opts.beforeId },
        );
      } else {
        qb.andWhere('m.created_at < :before', { before: opts.before });
      }
    }
    // @DeleteDateColumn makes the QueryBuilder exclude soft-deleted rows.
    const rows = await qb
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit)
      .getMany();
    return rows.map(toMessageView);
  }

  async sendMessage(
    conversationId: string,
    userId: string,
    body: string,
  ): Promise<MessageView> {
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
    return this.postMessage(conversationId, userId, body);
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

  private async postMessage(
    conversationId: string,
    senderId: string,
    body: string,
  ): Promise<MessageView> {
    const saved = await this.messages.save(
      this.messages.create({ conversationId, senderId, body }),
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
