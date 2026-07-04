import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  MoreThan,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
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

    const others = await this.participants.find({
      where: { conversationId: In(convoIds), userId: Not(userId) },
    });
    const otherByConvo = new Map(others.map((o) => [o.conversationId, o]));
    const otherProfiles = await this.profiles.find({
      where: { userId: In(others.map((o) => o.userId)) },
    });
    const profileByUser = new Map(otherProfiles.map((p) => [p.userId, p]));

    const summaries: ConversationSummary[] = [];
    for (const part of myParts) {
      const convo = convoById.get(part.conversationId);
      if (!convo) {
        continue;
      }
      const lastMessage = await this.messages.findOne({
        where: { conversationId: part.conversationId },
        order: { createdAt: 'DESC' },
      });
      const unreadCount = await this.messages.count({
        where: {
          conversationId: part.conversationId,
          senderId: Not(userId),
          ...(part.lastReadAt ? { createdAt: MoreThan(part.lastReadAt) } : {}),
        },
      });
      const other = otherByConvo.get(part.conversationId);
      summaries.push({
        id: convo.id,
        isOfficial: convo.isOfficial,
        otherMember: toConversationMemberView(
          other ? profileByUser.get(other.userId) : undefined,
        ),
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              senderId: lastMessage.senderId,
              body: lastMessage.body,
              createdAt: lastMessage.createdAt,
            }
          : null,
        unreadCount,
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

  async getMessages(
    conversationId: string,
    userId: string,
    opts: { before?: string; limit?: number },
  ): Promise<MessageView[]> {
    await this.requireParticipant(conversationId, userId);
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :id', { id: conversationId });
    if (opts.before) {
      qb.andWhere('m.created_at < :before', { before: opts.before });
    }
    // @DeleteDateColumn makes the QueryBuilder exclude soft-deleted rows.
    const rows = await qb.orderBy('m.created_at', 'DESC').take(limit).getMany();
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
    const part = await this.requireParticipant(conversationId, userId);
    const lastReadAt = new Date();
    part.lastReadAt = lastReadAt;
    await this.participants.save(part);
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
