import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { toImageUrl } from '../common/image-url';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import {
  AuthorSummary,
  ConversationResponse,
  toAuthorSummary,
} from './message-response';
import { MessagingCoreService } from './messaging-core.service';
import {
  MESSAGE_DELIVERED,
  MESSAGE_READ,
  MessageDeliveredEvent,
  MessageReadEvent,
} from './messaging.events';

/**
 * Conversations concern of the split `MessagingService`: the inbox
 * (`listConversations`), 1:1 DM creation, and per-participant conversation
 * preferences (read/delivered watermarks, mute, "delete for me"/`clearedAt`).
 * Group membership/roster mutations live in `GroupsService`; message
 * send/read/search/edit/delete live in `MessagesService`.
 *
 * Every read here goes through `MessagingCoreService.requireParticipant` for
 * the caller's `clearedAt` floor — never a locally re-derived copy — so
 * "delete for me" semantics can't drift from the other split services.
 */
@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
    // Batched crop lookup (`MediaCropService.getMany`) for a group's
    // `avatarUrl` sibling `avatarCrop`.
    private readonly mediaCropService: MediaCropService,
  ) {}

  async listConversations(userId: string): Promise<ConversationResponse[]> {
    // Bounded ceiling: the endpoint returns a bare array (no pagination
    // envelope — the FE `getConversations` normalizes either shape), so cap the
    // participant fan-out at DEFAULT_LIST_LIMIT rather than loading every row +
    // IN() fan-out + in-memory sort unbounded. Sized well above any real inbox,
    // so existing callers behave identically; the response contract is unchanged.
    //
    // Order by last activity BEFORE the take so the retained subset is
    // DETERMINISTIC — the DEFAULT_LIST_LIMIT most-recently-active conversations,
    // which is exactly what an over-cap inbox wants — rather than an arbitrary
    // slice of an unordered scan. "Last activity" mirrors the derived `updatedAt`
    // below: the newest non-deleted message's timestamp, falling back to the
    // conversation's own creation for an empty thread. The correlated MAX rides
    // the composite index messages (conversation_id, created_at); with no joins
    // on this builder, `.take()` emits a plain LIMIT (no distinct-pagination).
    const lastActivityExpression = `COALESCE(
        (SELECT MAX(message.created_at) FROM messages message
          WHERE message.conversation_id = participant.conversation_id
            AND message.deleted_at IS NULL),
        (SELECT conversation.created_at FROM conversations conversation
          WHERE conversation.id = participant.conversation_id)
      )`;
    const myParts = await this.participants
      .createQueryBuilder('participant')
      .where('participant.user_id = :userId', { userId })
      .orderBy(lastActivityExpression, 'DESC')
      .take(DEFAULT_LIST_LIMIT)
      .getMany();
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
    // ONE batched crop lookup for every group avatar in the inbox — never a
    // per-conversation query. DM/official threads carry no `avatarUrl`.
    const [lastByConvo, unreadByConvo, groupAvatarCrops] = await Promise.all([
      this.core.lastMessagesByConversation(convoIds),
      this.core.unreadCountsByConversation(convoIds, userId),
      this.mediaCropService.getMany(
        convos.flatMap((convo) =>
          convo.kind === ConversationKind.Group && convo.avatarUrl
            ? [convo.avatarUrl]
            : [],
        ),
      ),
    ]);
    const reactionsByMessage = await this.core.reactionSummariesByMessage(
      [...lastByConvo.values()].map((m) => m.id),
      userId,
    );

    // A block severs a 1:1 DM either direction (mirrors `canSendMessage`'s
    // send-time gate and `createConversation`'s create-time gate). History
    // stays intact server-side for moderation — this only stops surfacing the
    // thread in the caller's own inbox, matching the client's own
    // `isBlocked`-based filter (`useMessagesController.ts` "DM severance")
    // so a hard reload / live-mode fetch can't show a thread the FE would
    // otherwise hide, and a stale unread count from before the block can't
    // linger on a thread the member can no longer open. Batched (one query
    // regardless of inbox size), not per-conversation.
    const blockedCounterparts = await this.blockFilter.blockedUserIds(
      userId,
      others.map((o) => o.userId),
    );

    const summaries: ConversationResponse[] = [];
    for (const part of myParts) {
      const convo = convoById.get(part.conversationId);
      if (!convo) {
        continue;
      }
      const isGroup = convo.kind === ConversationKind.Group;
      const convoOthers = othersByConvo.get(convo.id) ?? [];
      if (
        !isGroup &&
        !convo.isOfficial &&
        convoOthers.some((o) => blockedCounterparts.has(o.userId))
      ) {
        continue;
      }
      let otherParticipant: AuthorSummary | null = null;
      // 1:1 thread: the single counterpart. Official/welcome AND group threads
      // have no single "other participant" — the client shows the org identity
      // or the group title instead — so `first` stays undefined and the
      // counterpart fields below fall back to null.
      const first = convo.isOfficial || isGroup ? undefined : convoOthers[0];
      if (!convo.isOfficial && !isGroup) {
        otherParticipant = toAuthorSummary(
          first ? profileByUser.get(first.userId) : undefined,
        );
      }
      // Group roster: this caller's own participant row (`part`) + every other
      // participant, mapped to member summaries with roles.
      const members = isGroup
        ? this.core.buildMemberSummaries([part, ...convoOthers], profileByUser)
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
          ? this.core.buildLastMessagePreview(
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
        avatarCrop: isGroup
          ? cropFor(convo.avatarUrl, groupAvatarCrops)
          : undefined,
        memberCount: members.length,
        members,
        isOfficial: convo.isOfficial,
        muted: part.muted,
        pinnedAt: part.pinnedAt?.toISOString() ?? null,
        favorite: part.favoritedAt != null,
        hasLeft: isGroup ? part.leftAt != null : false,
        ...(isGroup
          ? this.core.groupCapabilities(part.role, part.leftAt != null)
          : {}),
      });
    }
    // Most recently active first. ISO-8601 UTC strings are fixed-width, so
    // lexicographic order is chronological order.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /** Count of the caller's conversations with unread messages — the nav DM
   *  badge's cheap single number, so it never fetches the whole inbox. */
  unreadConversationCount(userId: string): Promise<number> {
    return this.core.unreadConversationCount(userId);
  }

  async markRead(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    await this.core.requireParticipant(conversationId, userId);
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
    const part = await this.core.requireParticipant(conversationId, userId);
    part.muted = muted;
    await this.participants.save(part);
    return { ok: true };
  }

  /** Maximum conversations one user may pin at once. Enforced server-side in
   *  `setPinned`; the client mirrors it but is never trusted. */
  private static readonly MAX_PINNED_CONVERSATIONS = 3;

  /**
   * Pin/unpin a conversation for THIS caller only (mirrors `setMuted`), stamping
   * `pinnedAt` with the app clock (NULL = unpinned). Pinning is capped at
   * `MAX_PINNED_CONVERSATIONS` per user: if the caller already has that many
   * OTHER pinned conversations, a 409 `ConflictException` is thrown. Unpinning is
   * always allowed, and re-pinning an already-pinned thread just re-stamps it.
   */
  async setPinned(
    conversationId: string,
    userId: string,
    pinned: boolean,
  ): Promise<{ ok: true }> {
    const part = await this.core.requireParticipant(conversationId, userId);
    if (pinned && part.pinnedAt == null) {
      const otherPinnedCount = await this.participants.count({
        where: {
          userId,
          pinnedAt: Not(IsNull()),
          conversationId: Not(conversationId),
        },
      });
      if (otherPinnedCount >= ConversationsService.MAX_PINNED_CONVERSATIONS) {
        throw new ConflictException('You can pin up to 3 chats.');
      }
    }
    part.pinnedAt = pinned ? new Date() : null;
    await this.participants.save(part);
    return { ok: true };
  }

  /**
   * Favorite/unfavorite a conversation for THIS caller only (mirrors `setMuted`),
   * stamping `favoritedAt` with the app clock (NULL = not favorited). No cap.
   */
  async setFavorite(
    conversationId: string,
    userId: string,
    favorite: boolean,
  ): Promise<{ ok: true }> {
    const part = await this.core.requireParticipant(conversationId, userId);
    part.favoritedAt = favorite ? new Date() : null;
    await this.participants.save(part);
    return { ok: true };
  }

  isParticipant(conversationId: string, userId: string): Promise<boolean> {
    return this.participants.exists({ where: { conversationId, userId } });
  }

  /**
   * Stricter join gate for a LIVE socket room (`ChatGateway.handleJoin`) than
   * plain participation (`isParticipant`): also refuses a participant who
   * left/was removed from a group (no live room for them — history stays
   * reachable over HTTP, ceilinged at their `leftAt` — see
   * `MessagesService.getMessages`) and a DM whose counterpart is blocked
   * either way (so a block also cuts off live message/typing reception, not
   * just new sends via `MessagesService.sendMessage`'s own block check).
   * Never throws — a boolean the gateway itself converts to a `WsException`.
   */
  async canJoinConversationLive(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const participant = await this.participants.findOne({
      where: { conversationId, userId },
    });
    if (!participant || participant.leftAt) {
      return false;
    }
    const convo = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (convo && convo.kind !== ConversationKind.Group && !convo.isOfficial) {
      const other = await this.participants.findOne({
        where: { conversationId, userId: Not(userId) },
      });
      if (
        other &&
        (await this.blockFilter.isBlockedEitherWay(userId, other.userId))
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * `POST /conversations` — create-or-return the DM with `recipientHandle`
   * (this backend's `slug`). Thin wrapper over the same
   * `getOrCreateConversation` helper `MessageRequestsService.messageRequest`
   * uses, minus the required first message: opening a thread from a profile
   * shouldn't force the caller to have already typed something, and this is
   * intentionally idempotent (repeat calls return the same conversation). No
   * connection check here — `MessagesService.sendMessage` already gates
   * actually messaging — but a block either way is a hard stop: a blocked user
   * cannot even open a thread.
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

    const { conversation } = await this.core.getOrCreateConversation(
      userId,
      recipient.userId,
    );
    return this.toConversationResponse(conversation, userId, recipient.userId);
  }

  /** Builds the frontend-contract `ConversationResponse` for a 1:1 DM. */
  async toConversationResponse(
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
      this.core.lastMessagesByConversation([convo.id]),
      this.core.unreadCountsByConversation([convo.id], userId),
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
    const reactionsByMessage = await this.core.reactionSummariesByMessage(
      clearedLastMessage ? [clearedLastMessage.id] : [],
      userId,
    );

    return {
      id: convo.id,
      type: convo.isOfficial ? 'group' : 'dm',
      otherParticipant: toAuthorSummary(profileByUser.get(otherUserId)),
      lastMessage: clearedLastMessage
        ? this.core.buildLastMessagePreview(
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
}
