import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import {
  MessageResponse,
  MessageSearchConversationGroup,
  requireAuthorSummary,
  StarredMessageHit,
  StarredMessagesResponse,
  toAuthorSummary,
} from './message-response';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_PINNED_MESSAGES,
  MAX_SEARCH_LIMIT,
} from './messaging.constants';
import {
  MESSAGE_PINNED,
  MESSAGE_REACTION,
  MessagePinnedEvent,
  MessageReactionCount,
  MessageReactionEvent,
} from './messaging.events';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Annotations concern of the split `MessagingService`: per-message reactions,
 * SHARED conversation pins, and PRIVATE per-user stars. Thread/send/edit/
 * delete lives in `MessagesService`; conversation-level state lives in
 * `ConversationsService`.
 *
 * Every read here goes through `MessagingCoreService.requireParticipant` (for
 * the caller's `clearedAt` floor) and `toMessageResponses` — never a locally
 * re-derived copy — so pin/star listings can't diverge from the thread view's
 * "delete for me" semantics.
 */
@Injectable()
export class MessageAnnotationsService {
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
    private readonly core: MessagingCoreService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Reactions/pins/stars are addressed by (conversationId, messageId): confirms
  // the message actually belongs to the conversation the caller is a
  // participant of, so a participant of conversation A cannot annotate a
  // message that only lives in conversation B.
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

  async addMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const pinRows = await this.pins.find({
      where: { conversationId },
      order: { pinnedAt: 'DESC' },
      // Bounded: the banner shows the newest pins; an unbounded scan of every
      // pin a thread ever accrued is never needed.
      take: MAX_PINNED_MESSAGES,
    });
    if (!pinRows.length) {
      return [];
    }
    const messages = await this.messages.find({
      where: { id: In(pinRows.map((pin) => pin.messageId)) },
    });
    const messageById = new Map(
      messages.map((message) => [message.id, message]),
    );
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
    return this.core.toMessageResponses(ordered, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
    await this.stars.delete({ userId, messageId });
    return { ok: true };
  }

  /**
   * The caller's starred messages, newest-star-first, for the "Starred messages"
   * view. Scoped to the caller by construction (the star join is on
   * `user_id = :userId`), floored by their `clearedAt`, and excluding
   * soft-deleted messages — mirrors `MessagesService.searchMessages`' guards.
   * Returns each hit plus the per-conversation grouping metadata the client
   * renders/jumps with.
   */
  async listStarredMessages(
    userId: string,
    limit?: number,
  ): Promise<StarredMessagesResponse> {
    const cappedLimit = Math.min(
      limit ?? DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    // Order by star recency via the join; hydrate the exact `starredAt` in a
    // second batched query (avoids fragile raw-alias parsing).
    const messages = await this.messages
      .createQueryBuilder('m')
      .innerJoin(
        MessageStar,
        's',
        's.message_id = m.id AND s.user_id = :userId',
        {
          userId,
        },
      )
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
      // A moderator-taken-down message (hidden OR removed, keyed by the message
      // uuid) is dropped from the starred list too — its snippet below would
      // otherwise leak the withheld body. In-query so the capped page isn't
      // under-filled. `content_moderation.subject_id` is varchar; `m.id` is uuid.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :messageSubjectType
            AND "cm"."subject_id" = m.id::text
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        )`,
        { messageSubjectType: 'message' },
      )
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
}
