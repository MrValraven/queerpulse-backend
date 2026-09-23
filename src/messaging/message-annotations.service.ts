import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { toImageUrl } from '../common/image-url';
import {
  foldedHaystack,
  foldedSearchTerm,
  foldedTextExpression,
} from '../search/search-text';
import { Profile } from '../users/entities/profile.entity';
import { LINK_BODY_PATTERN } from './conversation-media.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  isStickerAttachment,
  Message,
  MessageKind,
} from './entities/message.entity';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
} from './message-history-cursor';
import {
  messageKindToResponseKind,
  MessageReactorsResponse,
  MessageResponse,
  MessageSearchConversationGroup,
  requireAuthorSummary,
  resolveAttachment,
  StarredMessageHit,
  StarredMessagesResponse,
} from './message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import { StarredMessagesFilterType } from './dto/starred-messages.query';
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
import {
  collapseBusinessReactions,
  mailboxStaffHistoryFloorCoversPredicate,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';

/** Cap on one message's "who reacted" list (PRD-352). */
const MAX_MESSAGE_REACTORS = 200;

/**
 * ENG-240: a conversation's pinned-messages banner is bounded to
 * `MAX_PINNED_MESSAGES`; a new pin attempted once a GROUP already carries
 * the cap is refused with this code so the frontend can show a specific
 * toast rather than a generic error. Mirrors
 * `CONVERSATION_REQUIRES_CONNECTION_CODE`'s coded-exception convention
 * (`conversations.service.ts`).
 */
export const PIN_LIMIT_REACHED_CODE = 'PIN_LIMIT_REACHED';

/**
 * ENG-240: coded refusal when a GROUP member who is neither owner nor admin
 * tries to pin/unpin a shared message (`assertCanManageGroupPins`), so the
 * frontend can show a specific message rather than a generic 403.
 */
export const GROUP_ROLE_REQUIRED_CODE = 'GROUP_ROLE_REQUIRED';

/** A reaction row with its reactor's profile joined on (`listMessageReactors`). */
type ReactionWithProfile = MessageReaction & { profile?: Profile };

/**
 * Annotations concern of the split `MessagingService`: per-message reactions,
 * SHARED conversation pins, PRIVATE per-user stars, and PRIVATE per-user
 * message hides ("delete for me", PRD-227 — distinct from the whole-thread
 * `clearConversation` "delete for me" in `ConversationsService`). Thread/
 * send/edit/delete-for-everyone lives in `MessagesService`; conversation-
 * level state lives in `ConversationsService`.
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
    @InjectRepository(MessageHide)
    private readonly hides: Repository<MessageHide>,
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

  /**
   * Task 13h: a reaction, pin or star WRITE on a message at or before the
   * history floor of the caller's mailbox staff seat is refused with the
   * same 404 as a message outside the conversation. A co-manager seated
   * when a personal thread moved into a business mailbox holds a floor at
   * its first enquiry, and an unavailable quote still carries its parent's
   * id, so without this they could react to, pin or star the owner's and
   * the customer's earlier private messages by id. The rule is read through
   * `mailboxStaffHistoryFloorCoversPredicate`, which reads the seat's
   * `historyFloorAt`, so a "clear chat" on any seat, a staff seat included,
   * keeps every write it had. A seat with no history floor costs no query.
   */
  private async assertAboveMailboxStaffFloor(
    callerSeat: ConversationParticipant,
    messageId: string,
  ): Promise<void> {
    if (!callerSeat.historyFloorAt) {
      return;
    }
    const isBelowFloor = await this.messages
      .createQueryBuilder('message')
      .withDeleted()
      .innerJoin(ConversationParticipant, 'seat', 'seat.id = :callerSeatId', {
        callerSeatId: callerSeat.id,
      })
      .where('message.id = :messageId', { messageId })
      .andWhere(
        mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'seat'),
      )
      .getExists();
    if (isBelowFloor) {
      throw new NotFoundException('Message not found');
    }
  }

  async addMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    // Active participation, not mere participation: a removed group member or
    // a blocked DM counterpart must not be able to fire a live `reaction`
    // frame into a room they can no longer read (BE-MSG-09).
    const participant = await this.core.requireActiveParticipant(
      conversationId,
      userId,
    );
    // Task 7: this seat speaks for `participant.identityId` (a business
    // identity for a mailbox thread). Reacting under that seat requires the
    // caller to still be entitled to act as it right now, checked fresh on
    // every write regardless of what the seat allowed when it was created.
    await this.core.assertMaySendAs(
      conversationId,
      userId,
      participant.identityId,
    );
    await this.requireMessageInConversation(conversationId, messageId);
    await this.assertAboveMailboxStaffFloor(participant, messageId);

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
    // Un-reacting broadcasts the same `reaction` frame as reacting, so it is
    // gated identically (BE-MSG-09).
    const participant = await this.core.requireActiveParticipant(
      conversationId,
      userId,
    );
    // Task 7: see the matching comment in `addMessageReaction`.
    await this.core.assertMaySendAs(
      conversationId,
      userId,
      participant.identityId,
    );
    await this.requireMessageInConversation(conversationId, messageId);
    await this.assertAboveMailboxStaffFloor(participant, messageId);

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
   * The members who reacted to one message, for the "who reacted" sheet
   * (PRD-352). A READ, so it takes the lenient `requireParticipant` (a former
   * group member still reads their ceilinged history). The message must then
   * be one the caller can actually see in their thread: not soft-deleted
   * (`requireMessageInConversation`'s default `findOne` skips a tombstone),
   * inside their `clearedAt` floor and `leftAt` ceiling, not hidden for them
   * ("delete for me", PRD-227), and not a moderator takedown (the read path
   * empties a taken-down message's reactions). Every refusal past
   * participation is the same 404, so the route never confirms a message the
   * caller cannot see.
   *
   * One query joins each reaction row to its reactor's profile (no N+1),
   * capped at `MAX_MESSAGE_REACTORS`. `message_reactions` has no timestamp, so
   * the order is deterministic instead of chronological: the caller's own
   * rows first (so their "Tap to remove" survives the cap), then reaction key
   * order (the enum's declaration order), then name. No block filter: no
   * message read in this module filters by blocks (a group keeps a blocked
   * member's messages and reactions visible), so this list does not add one.
   */
  async listMessageReactors(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<MessageReactorsResponse> {
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const message = await this.requireMessageInConversation(
      conversationId,
      messageId,
    );
    const isBeforeClearPoint =
      !!participant.clearedAt && message.createdAt <= participant.clearedAt;
    const isAfterLeaving =
      !!participant.leftAt && message.createdAt > participant.leftAt;
    if (isBeforeClearPoint || isAfterLeaving) {
      throw new NotFoundException('Message not found');
    }
    // A moderator hide withholds the message from ordinary participants only:
    // the thread still shows it to staff, so their "Reactions" must open too.
    const [isHiddenForCaller, isTakenDown] = await Promise.all([
      this.hides.exist({ where: { userId, messageId } }),
      this.core.isMessageWithheldFromViewer(messageId, userId),
    ]);
    if (isHiddenForCaller || isTakenDown) {
      throw new NotFoundException('Message not found');
    }

    const rows = (await this.reactions
      .createQueryBuilder('reaction')
      .innerJoinAndMapOne(
        'reaction.profile',
        Profile,
        'profile',
        'profile.user_id = reaction.user_id',
      )
      .where('reaction.message_id = :messageId', { messageId })
      .orderBy(
        'CASE WHEN reaction.user_id = :viewerId THEN 0 ELSE 1 END',
        'ASC',
      )
      .setParameter('viewerId', userId)
      .addOrderBy('reaction.key', 'ASC')
      .addOrderBy('profile.firstName', 'ASC')
      .addOrderBy('profile.lastName', 'ASC')
      .addOrderBy('reaction.userId', 'ASC')
      .limit(MAX_MESSAGE_REACTORS)
      .getMany()) as ReactionWithProfile[];

    // Task 13e: a customer reading a business mailbox thread sees the
    // business react once per key, listed where its first staff reaction
    // under that key falls. The business's own staff see individuals.
    const reactorView = await this.core.loadReactorView(
      conversationId,
      participant,
    );
    const businessUserIds: ReadonlySet<string> =
      reactorView.shape === 'customerOfMailbox'
        ? reactorView.businessUserIds
        : new Set();
    const visibleRows =
      reactorView.shape === 'ownOnly'
        ? rows.filter((row) => row.userId === userId)
        : collapseBusinessReactions(rows, businessUserIds);
    const reactors: MessageReactorsResponse['reactors'] = visibleRows.map(
      (row) => ({
        key: row.key,
        member:
          reactorView.shape === 'customerOfMailbox' &&
          businessUserIds.has(row.userId)
            ? reactorView.business
            : requireAuthorSummary(row.profile),
        isMine: row.userId === userId,
        reactedAt: null,
      }),
    );
    return { reactors };
  }

  // ── Pins (SHARED, per-conversation) ────────────────────────────────────────

  /**
   * ENG-240: in a GROUP conversation, only the owner or an admin may pin or
   * unpin a shared message — mirrors `GroupsService`'s owner/admin gate on
   * every other write that reaches the whole room (a member pinning
   * hundreds of messages fans a refresh frame to every other member, and
   * inflates the banner they all see). A DM is unchanged: either
   * participant may pin/unpin, exactly as before.
   */
  private async assertCanManageGroupPins(
    conversationId: string,
    participant: ConversationParticipant,
  ): Promise<void> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: ['kind'],
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.kind !== ConversationKind.Group) {
      return;
    }
    if (
      participant.role !== ConversationRole.Owner &&
      participant.role !== ConversationRole.Admin
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Only a group owner or admin may pin or unpin a message',
        code: GROUP_ROLE_REQUIRED_CODE,
      });
    }
  }

  /**
   * Pin a message in a conversation. SHARED: in a DM either participant may
   * pin, both see it; in a GROUP only the owner/admin may (ENG-240,
   * `assertCanManageGroupPins`). Idempotent — `ON CONFLICT DO NOTHING` on
   * UNIQUE(conversation, message) absorbs a re-pin (or a race) without a
   * 23505. Records the pinner. `requireMessageInConversation` rejects a
   * message that isn't in this thread or has been (soft-)deleted, so a
   * tombstone can't be pinned. Refuses a NEW pin once the conversation
   * already holds `MAX_PINNED_MESSAGES` (ENG-240) — an idempotent re-pin of
   * an already-pinned message is exempt, since it adds no row and so cannot
   * itself push the conversation over the cap: an already-pinned message
   * skips the insert entirely (no `createQueryBuilder` call, no cap check),
   * rather than issuing a no-op `orIgnore()` insert. Emits MESSAGE_PINNED
   * only when the insert's `RETURNING` actually reported a row
   * (`inserted.raw.length > 0`), never `inserted.identifiers`: TypeORM
   * populates that from the values passed in regardless of whether `ON
   * CONFLICT DO NOTHING` suppressed the row, so it is always non-empty here
   * and cannot tell a real insert from a no-op.
   */
  async pinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    // Pins are SHARED and broadcast to the whole room, so only an active
    // participant may place one (BE-MSG-09).
    const participant = await this.core.requireActiveParticipant(
      conversationId,
      userId,
    );
    // Task 7: see the matching comment in `addMessageReaction`. Checked
    // before the group-role gate below: whether this human may act as the
    // seat's identity at all is the more fundamental of the two questions.
    await this.core.assertMaySendAs(
      conversationId,
      userId,
      participant.identityId,
    );
    await this.assertCanManageGroupPins(conversationId, participant);
    await this.requireMessageInConversation(conversationId, messageId);
    await this.assertAboveMailboxStaffFloor(participant, messageId);

    const alreadyPinned = await this.pins.exist({
      where: { conversationId, messageId },
    });
    if (alreadyPinned) {
      return { ok: true };
    }

    const pinCount = await this.pins.count({ where: { conversationId } });
    if (pinCount >= MAX_PINNED_MESSAGES) {
      throw new ConflictException({
        statusCode: 409,
        message: `A conversation can have at most ${MAX_PINNED_MESSAGES} pinned messages`,
        code: PIN_LIMIT_REACHED_CODE,
      });
    }

    const inserted = await this.pins
      .createQueryBuilder()
      .insert()
      .into(ConversationPinnedMessage)
      .values({ conversationId, messageId, pinnedBy: userId })
      .orIgnore()
      .execute();
    if (inserted.raw.length > 0) {
      this.eventEmitter.emit(MESSAGE_PINNED, {
        conversationId,
        messageId,
        pinned: true,
      } satisfies MessagePinnedEvent);
    }
    return { ok: true };
  }

  /**
   * Unpin a message. SHARED — in a DM either participant may unpin; in a
   * GROUP only the owner/admin may (ENG-240, `assertCanManageGroupPins`).
   * Idempotent — a delete of a non-existent pin is a no-op success. Emits
   * MESSAGE_PINNED only when the delete actually affected a row, mirroring
   * `pinMessage`'s no-op guard.
   */
  async unpinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    // Unpinning mutates SHARED state and broadcasts, exactly like pinning
    // (BE-MSG-09).
    const participant = await this.core.requireActiveParticipant(
      conversationId,
      userId,
    );
    // Task 7: see the matching comment in `pinMessage`.
    await this.core.assertMaySendAs(
      conversationId,
      userId,
      participant.identityId,
    );
    await this.assertCanManageGroupPins(conversationId, participant);
    await this.assertAboveMailboxStaffFloor(participant, messageId);
    const result = await this.pins.delete({ conversationId, messageId });
    if (result.affected) {
      this.eventEmitter.emit(MESSAGE_PINNED, {
        conversationId,
        messageId,
        pinned: false,
      } satisfies MessagePinnedEvent);
    }
    return { ok: true };
  }

  /**
   * The conversation's pinned messages, newest-pin-first, as full
   * `MessageResponse`s (so the banner has body/sender/pinnedAt and can jump to
   * the original). Floored by the caller's `clearedAt` and excluding
   * soft-deleted messages — a pin whose message was cleared/deleted simply drops
   * out of the banner (the DB row lingers harmlessly until the message is hard
   * deleted, which cascades it away). Also excludes a message THIS caller hid
   * (PRD-227 "delete for me") — the pin itself is SHARED, so the other
   * participant's banner is unaffected.
   *
   * ENG-240: `pinMessage` refuses a NEW pin once a conversation already
   * holds `MAX_PINNED_MESSAGES`, so from that fix forward no conversation
   * can ever accumulate more pin rows than the cap — this initial
   * `pins.find` is bounded to `take: MAX_PINNED_MESSAGES` (newest first) so
   * a conversation cannot make every viewer's banner load pull an unbounded
   * number of pin rows (and their messages) into memory. The per-viewer
   * eligibility filtering below (clear floor, leftAt ceiling, this caller's
   * own hides) then narrows that bounded set further; it can only under-fill
   * a legacy conversation that had already exceeded the cap before this fix
   * shipped, which self-heals as those old pins are unpinned or age out.
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
    const hiddenMessageIds = messageById.size
      ? new Set(
          (
            await this.hides.find({
              where: { userId, messageId: In([...messageById.keys()]) },
            })
          ).map((hide) => hide.messageId),
        )
      : new Set<string>();
    const ordered: Message[] = [];
    for (const pin of pinRows) {
      // Cap AFTER filtering (see this method's own doc) — stop as soon as the
      // banner has enough eligible pins, never before.
      if (ordered.length >= MAX_PINNED_MESSAGES) break;
      const message = messageById.get(pin.messageId);
      // Drop a pin whose message is gone (soft-deleted / hard-removed) or falls
      // at-or-before the caller's clear floor — it doesn't exist for them.
      if (!message) continue;
      if (hiddenMessageIds.has(pin.messageId)) continue;
      if (participant.clearedAt && message.createdAt <= participant.clearedAt) {
        continue;
      }
      // leftAt ceiling, mirroring `MessagesService.getMessages`: a pin placed
      // after a member left the group is not theirs to read.
      if (participant.leftAt && message.createdAt > participant.leftAt) {
        continue;
      }
      ordered.push(message);
    }
    return this.core.toMessageResponses(
      ordered,
      userId,
      Boolean(participant.leftAt),
    );
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
    // Private, but still a write into a conversation the caller may no longer
    // act in (BE-MSG-09). `unstarMessage` deliberately keeps the lenient check
    // below: removing your own bookmark emits nothing and must stay possible.
    const participant = await this.core.requireActiveParticipant(
      conversationId,
      userId,
    );
    await this.requireMessageInConversation(conversationId, messageId);
    await this.assertAboveMailboxStaffFloor(participant, messageId);
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

  // ── Hides (PRIVATE, per-user "delete for me" on ONE message — PRD-227) ─────

  /**
   * Hide a single message from THIS user's own view only ("delete for me"),
   * idempotent per (user, message). SITS BESIDE the existing author-or-staff
   * "delete for everyone" tombstone (`MessagesService.deleteMessage`,
   * `Message.deletedAt`) — the two never merge: a message can be hidden for
   * one viewer, tombstoned for everyone, both, or neither, independently.
   * Private by construction, exactly like `starMessage`: no event is
   * emitted, so the other participant's view (and every OTHER participant's,
   * for a group) is completely unaffected and never looks like a tombstone
   * to them.
   *
   * Unlike reactions/pins/stars, this uses the lenient `requireParticipant`
   * (not `requireActiveParticipant`): hiding something from your OWN view is
   * harmless self-service that must stay possible even after leaving a group
   * or being blocked — mirrors `unstarMessage`/`clearConversation`. A
   * tombstoned message can still be hidden (`withDeleted: true`), so a
   * member can clear even a "This message was deleted" placeholder out of
   * their own view — no unhide is offered from the UI, matching
   * WhatsApp/Telegram.
   */
  async hideMessageForMe(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    const message = await this.messages.findOne({
      where: { id: messageId, conversationId },
      withDeleted: true,
    });
    if (!message) {
      throw new NotFoundException('Message not found');
    }
    await this.hides
      .createQueryBuilder()
      .insert()
      .into(MessageHide)
      .values({ userId, messageId })
      .orIgnore()
      .execute();
    return { ok: true };
  }

  /**
   * The caller's starred messages, newest-star-first, for the "Starred messages"
   * view. Scoped to the caller by construction (the star join is on
   * `user_id = :userId`), floored by their `clearedAt`, and excluding
   * soft-deleted messages — mirrors `MessagesService.searchMessages`' guards.
   * Returns each hit plus the per-conversation grouping metadata the client
   * renders/jumps with.
   *
   * PRD-374 additions:
   *  - **Paging.** Keyset over `(s.created_at, m.id)` DESC, fetching
   *    `limit + 1` rows to compute `hasMore`/`nextCursor` without a count
   *    query, exactly the pattern `MessagesService.getMessages` uses for
   *    thread history. The cursor codec is reused as-is from
   *    `message-history-cursor.ts`: it carries no message-specific field,
   *    just an exact timestamp and a uuid, so it needs no copy of its own.
   *  - **`q`.** Accent- and case-folded substring matching, via the shared
   *    `search-text.ts` vocabulary (`foldedHaystack`/`foldedSearchTerm`,
   *    `translate(lower(...))` under the hood, needing no `unaccent`
   *    extension or schema change), the same folding member/forum/connection
   *    search already use, so "joao" finds "João" here too. LIKE-escaped and
   *    bound as a parameter. Matches, in one OR: the message body, the
   *    attachment caption, a document's file name, the sender's display
   *    name, the group title (GROUP threads only), and the DM counterpart's
   *    display name (non-GROUP threads only, so a group's other members stay
   *    unprobed by name).
   *  - **`type`.** `photos` = kind image/gif, `documents` = kind document,
   *    `links` = an ordinary text bubble (`kind: user`) whose body matches
   *    `LINK_BODY_PATTERN`, mirroring `ConversationMediaService`'s own Links
   *    tab exactly, including the "captions don't count" rule: one
   *    link-matching definition for the whole product, reused here.
   */
  async listStarredMessages(
    userId: string,
    options: {
      limit?: number;
      q?: string;
      type?: StarredMessagesFilterType;
      cursor?: string;
      mailboxIdentityId?: string;
    } = {},
  ): Promise<StarredMessagesResponse> {
    const cappedLimit = Math.min(
      options.limit ?? DEFAULT_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
    );
    const trimmedQuery = options.q?.trim();
    // Task 24: `?as=` narrows the participant join below to the caller's own
    // seat that speaks for that mailbox. The caller
    // (`MessagingService.listStarredMessages`) authorizes the mailbox first.
    const { mailboxIdentityId } = options;
    const hasMailboxFilter = mailboxIdentityId !== undefined;

    const starredQuery = this.messages
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
        hasMailboxFilter
          ? 'p.conversation_id = m.conversation_id AND p.user_id = :userId AND p.identity_id = :mailboxIdentityId'
          : 'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        hasMailboxFilter ? { userId, mailboxIdentityId } : { userId },
      )
      // Read-only lookup for the group-title / DM-counterpart-name branches of
      // `q` below; every message has a conversation, so this never drops a row.
      .leftJoin(Conversation, 'c', 'c.id = m.conversation_id')
      .where('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // leftAt ceiling, mirroring `MessagesService.searchMessages` and
      // `getMessages`: a member removed from (or who left) a group stops at the
      // moment they left. A star can only be placed on a message that was
      // visible at the time, so this mostly guards the re-add case
      // (`GroupsService.addMembers` used to null `leftAt` out) — but the
      // invariant must hold identically on every listing path, not only most
      // of them.
      .andWhere('(p.left_at IS NULL OR m.created_at <= p.left_at)')
      // Task 13c fix round 1: a STAFF member blocked either way with a
      // mailbox thread's customer lists nothing from that thread. Task 14a:
      // nor does a staff member who has left the business. Task 14: nor
      // does either side of a thread whose customer blocked the business.
      .andWhere(
        `NOT ${seatExcludedFromMailboxPredicate('m.conversation_id', ':userId')}`,
      )
      // A moderator-taken-down message (hidden OR removed, keyed by the message
      // uuid) is dropped from the starred list too — its snippet below would
      // otherwise leak the withheld body. In-query so the capped page isn't
      // under-filled. `content_moderation.subject_id` is varchar; `m.id` is uuid.
      .andWhere(notModeratedMessagePredicate('m'), {
        messageSubjectType: MESSAGE_SUBJECT_TYPE,
      })
      // PRD-227 "delete for me": a message THIS caller hid drops out of their
      // own starred list too — their star row (private) lingers harmlessly,
      // mirroring how a star on a deleted message already lingers.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "message_hides" "mh"
          WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :userId
        )`,
        { userId },
      );
    // No `.withDeleted()`: the @DeleteDateColumn default filter drops tombstones.

    if (trimmedQuery) {
      const pattern = `%${escapeLikeTerm(trimmedQuery)}%`;
      // `translate()`/`lower()` only ever touch the accented-letter and case
      // pairs `foldedTextExpression` lists; `\`, `%`, and `_` sit outside
      // that set, so `escapeLikeTerm`'s escaping survives folding intact and
      // the LIKE pattern still means what `escapeLikeTerm` built it to mean.
      // Every side is folded with the SAME expression, so a plain `LIKE`
      // already gives a case-insensitive comparison: the `lower()` inside
      // the fold already normalized case on both sides.
      const foldedTerm = foldedSearchTerm('qPattern');
      // Task 13c: a person's name matches only where that person speaks as
      // themselves. A message sent AS a business (`sender_identity`) and a
      // staff seat on a business thread (`op_identity`) are skipped, so a
      // search for a staff member's name can never tell a customer which
      // business messages that person wrote, or that they work there.
      // `sender_profile`/`other_profile` stay lowercase snake_case
      // throughout, matching how `foldedHaystack` always quotes the alias it
      // is given (`"alias"."column"`): a lowercase alias, quoted or bare,
      // resolves to the identical name every time it is referenced, so
      // keeping every reference in this block the same case is what keeps
      // the `FROM`-declared alias and every later use pointing at the same
      // table.
      // `ESCAPE '\'` on every branch pins the escape character explicitly
      // (identical to the implicit Postgres default here, kept for
      // consistency with `ConnectionsService`/`ListingsService`'s own folded
      // `LIKE` comparisons).
      starredQuery.andWhere(
        `(
          ${foldedHaystack('m', ['body'])} LIKE ${foldedTerm} ESCAPE '\\'
          OR ${foldedTextExpression("coalesce(m.attachment ->> 'caption', '')")} LIKE ${foldedTerm} ESCAPE '\\'
          OR ${foldedTextExpression("coalesce(m.attachment ->> 'fileName', '')")} LIKE ${foldedTerm} ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM "profiles" "sender_profile"
            WHERE "sender_profile"."user_id" = m.sender_id
              AND EXISTS (
                SELECT 1 FROM "identities" "sender_identity"
                WHERE "sender_identity"."id" = m.sender_identity_id
                  AND "sender_identity"."kind" = 'profile'
              )
              AND ${foldedHaystack('sender_profile', ['first_name', 'last_name'])} LIKE ${foldedTerm} ESCAPE '\\'
          )
          OR (c.kind = 'group' AND ${foldedHaystack('c', ['title'])} LIKE ${foldedTerm} ESCAPE '\\')
          OR (
            c.kind <> 'group' AND EXISTS (
              SELECT 1 FROM "conversation_participants" "op"
              INNER JOIN "profiles" "other_profile" ON "other_profile"."user_id" = "op"."user_id"
              INNER JOIN "identities" "op_identity" ON "op_identity"."id" = "op"."identity_id"
              WHERE "op"."conversation_id" = m.conversation_id
                AND "op"."user_id" <> :userId
                AND "op_identity"."kind" = 'profile'
                AND ${foldedHaystack('other_profile', ['first_name', 'last_name'])} LIKE ${foldedTerm} ESCAPE '\\'
            )
          )
        )`,
        { qPattern: pattern },
      );
    }

    if (options.type === StarredMessagesFilterType.Photos) {
      starredQuery.andWhere('m.kind IN (:...photoKinds)', {
        photoKinds: [MessageKind.Image, MessageKind.Gif],
      });
    } else if (options.type === StarredMessagesFilterType.Documents) {
      starredQuery.andWhere('m.kind = :documentKind', {
        documentKind: MessageKind.Document,
      });
    } else if (options.type === StarredMessagesFilterType.Links) {
      starredQuery
        .andWhere('m.kind = :textKind', { textKind: MessageKind.User })
        .andWhere('m.body ~* :linkPattern', { linkPattern: LINK_BODY_PATTERN });
    }

    const decodedCursor = options.cursor
      ? decodeMessageHistoryCursor(options.cursor)
      : null;
    if (decodedCursor) {
      starredQuery.andWhere(
        '(s.created_at, m.id) < (:cursorStarredAt::timestamptz, :cursorMessageId::uuid)',
        {
          cursorStarredAt: decodedCursor.before,
          cursorMessageId: decodedCursor.beforeId,
        },
      );
    }

    // `.limit()`, not `.take()`: ordering by the joined alias `s.created_at`
    // trips TypeORM's distinct-pagination strategy (which `.take()` enables
    // whenever joins are present), and that path can't resolve column
    // metadata for a non-selected join alias — it dereferences
    // `undefined.databaseName` and throws. None of the joins above multiply
    // rows (MessageStar is UNIQUE(user, message); the participant join is
    // unique per (conversation, user); the conversation join is by primary
    // key), so a plain SQL LIMIT is exactly equivalent. `limit + 1` decides
    // `hasMore` without a count query, mirroring `getMessages`; the exact
    // microsecond `starredAt` rides along as a raw column, keeping
    // `nextCursor` lossless where the entity's `Date` alone would round.
    const { entities, raw } = await starredQuery
      .addSelect(
        `to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        'cursor_starred_at',
      )
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(cappedLimit + 1)
      .getRawAndEntities<{ m_id: string; cursor_starred_at: string }>();

    const hasMore = entities.length > cappedLimit;
    const messages = hasMore ? entities.slice(0, cappedLimit) : entities;
    const oldestRow = messages[messages.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && oldestRow) {
      const oldestRawRow = raw.find((rawRow) => rawRow.m_id === oldestRow.id);
      nextCursor = oldestRawRow
        ? encodeMessageHistoryCursor(
            oldestRawRow.cursor_starred_at,
            oldestRow.id,
          )
        : null;
    }

    if (!messages.length) {
      return { items: [], conversations: [], nextCursor: null, hasMore: false };
    }
    const starRows = await this.stars.find({
      where: { userId, messageId: In(messages.map((m) => m.id)) },
    });
    const starredAtById = new Map(
      starRows.map((star) => [star.messageId, star.createdAt.toISOString()]),
    );

    const conversationIds = [...new Set(messages.map((m) => m.conversationId))];
    const convos = await this.conversations.find({
      where: { id: In(conversationIds) },
    });
    const convoById = new Map(convos.map((c) => [c.id, c]));
    // Task 13c: the participants and senders rendered through the same
    // `loadMessageListContext` search uses, so a starred business message
    // names the business, filed under the business.
    const listContext = await this.core.loadMessageListContext(
      convos,
      messages,
      userId,
    );

    const conversations: MessageSearchConversationGroup[] = conversationIds.map(
      (conversationId) => {
        const convo = convoById.get(conversationId);
        const isOfficial = Boolean(convo?.isOfficial);
        // ENG-251: a starred hit inside a GROUP is filed under the group's own
        // identity, never an arbitrary member's, see the matching comment in
        // `MessagesService.searchMessages`.
        const isGroup = convo?.kind === ConversationKind.Group;
        return {
          conversationId,
          otherParticipant:
            isOfficial || isGroup
              ? null
              : listContext.renderCounterpart(conversationId),
          isOfficial,
          kind: isGroup ? 'group' : 'direct',
          title: isGroup ? (convo?.title ?? null) : null,
          avatarUrl: isGroup ? toImageUrl(convo?.avatarUrl ?? null) : null,
        };
      },
    );

    const items: StarredMessageHit[] = messages.map((m) => {
      const attachment = resolveAttachment(m.attachment);
      // A starred sticker stores no body text (see `MessagingCoreService.
      // postMessage`'s sticker branch), so its snippet uses the sticker's own
      // label.
      const snippet =
        attachment && isStickerAttachment(attachment)
          ? attachment.label
          : m.body.slice(0, 160);
      return {
        id: m.id,
        conversationId: m.conversationId,
        snippet,
        sender: listContext.renderSender(m),
        createdAt: m.createdAt.toISOString(),
        starredAt: starredAtById.get(m.id) ?? m.createdAt.toISOString(),
        // Coordinator follow-up (ENG-251): `kind`/`attachment` ride the same
        // `Message` row this query already selected in full, no extra query or
        // join, hand-mapped through the exact same resolvers
        // `toMessageResponses` uses (see the matching comment in
        // `MessagesService.searchMessages`).
        kind: messageKindToResponseKind(m.kind),
        attachment,
      };
    });

    return { items, conversations, nextCursor, hasMore };
  }
}
