import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  In,
  IsNull,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import {
  AttachmentInput,
  DocumentAttachment,
  GifAttachment,
  Message,
  MessageKind,
  StickerAttachment,
} from './entities/message.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { toStoredPlainText } from '../communities/community-plain-text';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { sanitizeMessageBody } from './dto/trim-message-body';
import {
  messageAttachmentReferenceFromImageUrl,
  storageKeyFromImageUrl,
} from '../common/image-url';
import { parseMessageAttachmentReference } from '../storage/message-attachment-reference';
import {
  messageAttachmentRouteStorageKey,
  viewableMessageAttachmentQuery,
  withMessageAttachmentRoute,
} from '../storage/message-attachment-route';
import { StorageService } from '../storage/storage.service';
import { parseStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { DOCUMENT_UPLOAD_TYPES } from '../storage/upload-content-types';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { StickerPackStatus } from '../stickers/entities/sticker-pack.entity';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  buildAuthorSummary,
  loadSenderIdentityContext,
  renderMessageSender,
  SenderIdentityContext,
} from './author-summary';
import {
  businessSeatUserIdsForViewer,
  collapseBusinessReactions,
  describeDirectThreadSeats,
  DirectThreadSeats,
  mailboxStaffHistoryFloorCoversPredicate,
  mailboxThreadPredicate,
  renderDirectCounterpart,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import {
  AuthorSummary,
  buildReplyTo,
  buildSystemEvent,
  ConversationMemberPreview,
  ConversationMemberSummary,
  FORMER_IDENTITY_AUTHOR,
  MessageResponse,
  messageKindToResponseKind,
  MessageView,
  presentSenderIds,
  ReactionSummary,
  requireAuthorSummary,
  resolveAttachment,
  senderAuthorSummary,
  toMessageReactionSummaries,
  toMessageView,
} from './message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import {
  applyUnreadConversationScope,
  notHiddenForViewerMessagePredicate,
  NOT_SENT_AS_SEAT_IDENTITY_PREDICATE,
} from './unread-conversations-query';
import { EDIT_WINDOW_MS } from './messaging.constants';
import {
  renderMessageByViewerClass,
  ViewerRenderClassKeyComponent,
} from './viewer-render-classes';
import { isEvidenceHoldActive } from './message-evidence-hold';
import { MESSAGE_CREATED, MessageCreatedEvent } from './messaging.events';
import {
  claimUnclaimedConversation,
  CONVERSATION_CLAIM_CHANGED,
  ConversationClaimChangedEvent,
} from './conversation-claim';
import {
  isSentByViewerField,
  movedNoteMailboxIdentityIds,
  toViewerMessageResponse,
  ViewerMessageResponse,
  withMovedNoteMailbox,
} from './viewer-message-fields';
import type { MessagingPrivacyDTO } from '../preferences/preferences-response';

/**
 * Final fix F1 (C3): whether `error` is `assertMaySendAs`'s seat refusal,
 * `IDENTITY_NOT_IN_CONVERSATION`, the one refusal a house-account official
 * send is exempt from.
 */
function isIdentityNotInConversationError(error: unknown): boolean {
  if (!(error instanceof ForbiddenException)) {
    return false;
  }
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'IDENTITY_NOT_IN_CONVERSATION'
  );
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
  // Fix round 1 (Task 11): which identity this message was sent AS, read by
  // `toMessageResponses` to render a business/persona/company sender as
  // itself instead of the staff member's own profile.
  | 'senderIdentityId'
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
> &
  // PRD-361: optional because only a persisted row carries it (a fresh
  // `MessageView` is never a tombstone). Read by `canReport` alone.
  Partial<Pick<Message, 'attachmentPurgeAfter'>>;

/**
 * Task 13e: how the reactors of a message are shown to one reader.
 * `individuals` names every reactor, as a group, an ordinary DM and a
 * business's own staff see them. `customerOfMailbox` is a customer reading a
 * business mailbox thread: every reaction made by a seat of the business
 * appears once per key as the business itself. `ownOnly` is a thread whose
 * seats cannot be attributed, where only the reader's own reactions are
 * listed, so no reactor who might be a staff member is named.
 */
export type ReactorView =
  | { shape: 'individuals' }
  | { shape: 'ownOnly' }
  | {
      shape: 'customerOfMailbox';
      businessUserIds: ReadonlySet<string>;
      business: AuthorSummary;
    };

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
/** ENG-253: cap on `buildMemberPreview`'s avatar-stack preview, see its own
 *  doc for why this is unrelated to `MAX_GROUP_MEMBERS`. */
const MAX_MEMBER_PREVIEW = 8;

/**
 * Task 23: logs a claim relay that threw after a reply claimed its thread.
 * Module-level, like `ConversationsService`'s own claim relay logger.
 */
const implicitClaimRelayLogger = new Logger('MessagingCoreService');

@Injectable()
export class MessagingCoreService {
  // A message is reported (and taken down) under the `message` subject code,
  // keyed by the message uuid — mirrors `ReportSubjectType.Message`.
  private static readonly MESSAGE_SUBJECT_TYPE = MESSAGE_SUBJECT_TYPE;

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
    // Read-only here: PRD-227 "delete for me" rows, needed only so
    // `toMessageResponses` can fold the VIEWER's own hides on a page's reply
    // parents into `hiddenReplyParentIds` (writes to this table live in
    // `MessageAnnotationsService.hideMessageForMe`).
    @InjectRepository(MessageHide)
    private readonly hides: Repository<MessageHide>,
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
    // Read-only here: resolves a `kind:'sticker'` send's `stickerId` to its
    // row (and published pack status) at write time. `StickersModule` exports
    // `TypeOrmModule` for exactly this, so no cycle and no re-registration of
    // the `Sticker` entity.
    @InjectRepository(Sticker)
    private readonly stickers: Repository<Sticker>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly usersService: UsersService,
    // Resolves a user to their own profile identity for the identity-keyed
    // `pair_key` (see `identityPairKey`/`getOrCreateConversation` below).
    // Tasks 7 and 8 also read `this.identities` for the mailbox and enquiry
    // flows, so every concern shares this one lookup rather than holding
    // its own copy.
    private readonly identities: IdentitiesService,
    // Fix round 1 (Task 11): `toMessageResponses`'s own identity-aware
    // sender wiring, resolving the staff first name (if any) a business
    // sender's message carries for THIS viewer.
    private readonly identityAttribution: IdentityAttributionService,
    // Final fix F1 (C1): copies a business, persona or company attachment
    // that a member forwards as themselves under their own key, see
    // `resolveForwardedAttachmentReference`. `StorageModule` is already
    // imported by `MessagingModule`. Typed optional so a spec that builds
    // this service by position keeps compiling; the module always injects
    // it.
    private readonly storage?: StorageService,
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
    // Task 13c fix round 1: a STAFF member blocked either way with a mailbox
    // thread's customer is out of that thread. Task 14a: so is a staff
    // member who has left the business, whose seat keeps its row with
    // `leftAt` stamped. Both rules live in
    // `staffSeatExcludedFromMailboxPredicate`. Every read and write in the
    // messaging services passes through here, so this one check covers
    // history, media, pins, reactions, read receipts, sends and claims alike.
    // The refusal is the plain "not a participant" one, so it says nothing
    // about the block, the departure or the person behind either. Task 14:
    // a customer who blocked the business is refused here the same way, as
    // is every staff member of it (`seatExcludedFromMailboxPredicate`).
    const isExcludedFromMailbox = await this.participants
      .createQueryBuilder('seat')
      .where('seat.id = :seatId', { seatId: part.id })
      .andWhere(
        seatExcludedFromMailboxPredicate(
          'seat.conversation_id',
          'seat.user_id',
        ),
      )
      .getExists();
    if (isExcludedFromMailbox) {
      throw new ForbiddenException('You are not a participant');
    }
    return part;
  }

  /**
   * Task 13h: the users of `conversationId` whose seat is a mailbox staff
   * seat with a history floor covering the message `messageId`, compared in
   * SQL through `mailboxStaffHistoryFloorCoversPredicate`, the one
   * definition of that rule. A live frame about such a message (an edit, a
   * reaction) skips them. A thread with no floored staff seat returns an
   * empty set, which is the common case, and a personal or group seat never
   * appears here. The join skips a soft-deleted message, which is never
   * edited. Task 13h review M5: a delete frame is about a message the
   * delete has just soft-deleted, so `shouldIncludeDeletedMessage` reads
   * the row whatever its `deleted_at`.
   */
  async loadMailboxStaffFlooredUserIds(
    conversationId: string,
    messageId: string,
    { shouldIncludeDeletedMessage = false } = {},
  ): Promise<Set<string>> {
    const queryBuilder = this.participants.createQueryBuilder('seat');
    if (shouldIncludeDeletedMessage) {
      queryBuilder.withDeleted();
    }
    const rows = await queryBuilder
      .select('seat.user_id', 'userId')
      .innerJoin(
        'messages',
        'floored_message',
        '"floored_message"."id" = :messageId AND "floored_message"."conversation_id" = seat.conversation_id',
        { messageId },
      )
      .where('seat.conversation_id = :conversationId', { conversationId })
      .andWhere(
        mailboxStaffHistoryFloorCoversPredicate(
          '"floored_message"."created_at"',
          'seat',
        ),
      )
      .getRawMany<{ userId: string }>();
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * The WRITE-path counterpart of {@link requireParticipant}: the caller must
   * not only be a participant, they must still be ENTITLED TO ACT in the
   * conversation.
   *
   * `requireParticipant` deliberately returns a row regardless of `leftAt`,
   * because reads still serve a former member their ceilinged history (Task
   * 14a: a departed STAFF seat of a mailbox thread is the one exception, and
   * `requireParticipant` refuses it outright). Every
   * WRITE, though, was gating on that same lenient check, so a member removed
   * from a group could keep reacting to and pinning/unpinning messages — each
   * one broadcasting a live `reaction` / `message:pinned` frame the remaining
   * members saw — and a blocked DM counterpart could pin, react, and fire
   * `read` receipts into the blocker's room. `sendMessage` and
   * `canJoinConversationLive` already applied both extra rules; this brings
   * every other write in line with them, in one place so they cannot drift.
   *
   * Two rules on top of participation:
   *  - **`leftAt`**: a member who left (or was removed from) a group may no
   *    longer write to it.
   *  - **blocks**: in a DIRECT, non-official thread, a block in EITHER
   *    direction severs writing. Groups are exempt for the same reason
   *    `sendMessage` exempts them (a block between two members does not
   *    dissolve the group), and so is the platform's official thread.
   *
   * Costs one extra query beyond `requireParticipant`, and only for a
   * conversation that actually has a counterpart to be blocked by — the kind /
   * `is_official` predicates live inside the same statement.
   */
  async requireActiveParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipant> {
    const participant = await this.requireParticipant(conversationId, userId);
    if (participant.leftAt) {
      throw new ForbiddenException('You have left this conversation');
    }
    const blockedCounterpart = await this.participants
      .createQueryBuilder('other')
      .innerJoin(Conversation, 'c', 'c.id = other.conversation_id')
      .where('other.conversation_id = :conversationId', { conversationId })
      .andWhere('other.user_id != :userId', { userId })
      .andWhere('c.kind != :groupKind', { groupKind: ConversationKind.Group })
      .andWhere('c.is_official = false')
      // Task 13c: a business mailbox thread takes the staff-seat rule that
      // `requireParticipant` above already applied: a block with the
      // customer removes that staff member alone (`blockedStaffSeatPredicate`),
      // the rule the inbox, the send-time gate and the live-room gate share.
      .andWhere(`NOT ${mailboxThreadPredicate('other.conversation_id')}`)
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "blocks" "b"
          WHERE ("b"."blocker_id" = :userId AND "b"."blocked_id" = other.user_id)
             OR ("b"."blocked_id" = :userId AND "b"."blocker_id" = other.user_id)
        )`,
      )
      .getExists();
    if (blockedCounterpart) {
      throw new ForbiddenException(
        'You cannot interact with this conversation',
      );
    }
    return participant;
  }

  /**
   * The two questions every write path must answer before a message is
   * stored: may this human speak for that identity at all, and does that
   * identity hold a seat in this thread. Both are needed. Staff of Cafe
   * Lisboa may act as Cafe Lisboa, and that says nothing about a thread they
   * were never part of.
   *
   * Called by every write in this module and its sibling messaging
   * services (send, edit, delete, react, pin) before the write itself, so a
   * caller who fails either question leaves no row behind.
   *
   * CW-28: `options` forwards to `IdentitiesService.assertMayActAs` as-is.
   * `deleteMessage`'s author branch is the only caller that ever sets
   * `isDeletingOwnMessage`, and only after it has confirmed the human is
   * that message's own author; every other write keeps calling this with no
   * options, so a moderation-removed persona still refuses there.
   *
   * CW-05: queries the seat directly by `(conversationId, identityId)`, an
   * existence check on the exact pair this call needs. The earlier shape
   * loaded every seat of the conversation and scanned it in JS, a cost that
   * grew with the thread's whole membership on every call.
   */
  async assertMaySendAs(
    conversationId: string,
    userId: string,
    identityId: string,
    options: { isDeletingOwnMessage?: boolean } = {},
  ): Promise<void> {
    await this.identities.assertMayActAs(userId, identityId, options);
    const isIdentityInThread = await this.participants.exist({
      where: { conversationId, identityId },
    });
    if (!isIdentityInThread) {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_IN_CONVERSATION',
        message: 'That identity is not part of this conversation',
      });
    }
  }

  /**
   * Task 13c: every seat of one DIRECT, non-official thread, described from
   * `callerSeat`'s side by the shared `describeDirectThreadSeats`, with the
   * seat identities resolved in one batched call. For a single-thread gate
   * (`sendMessageWithOutcome`, `canJoinConversationLive`) that must agree
   * with what `ConversationsService.buildConversationSummaries` shows.
   */
  async loadDirectThreadSeats(
    conversationId: string,
    callerSeat: ConversationParticipant,
  ): Promise<{
    threadSeats: DirectThreadSeats;
    otherSeats: ConversationParticipant[];
  }> {
    const seats = await this.participants.find({ where: { conversationId } });
    const otherSeats = seats.filter(
      (seat) => seat.userId !== callerSeat.userId,
    );
    const identities = await this.identities.getByIds([
      ...new Set([
        callerSeat.identityId,
        ...otherSeats.map((seat) => seat.identityId),
      ]),
    ]);
    const identityKindById = new Map(
      identities.map((identity) => [identity.id, identity.kind]),
    );
    return {
      threadSeats: describeDirectThreadSeats(
        callerSeat.identityId,
        otherSeats,
        identityKindById,
      ),
      otherSeats,
    };
  }

  /**
   * Task 13e: the {@link ReactorView} for `callerSeat`'s person in
   * `conversationId`, read from the same seat description every other
   * mailbox read surface uses (`loadDirectThreadSeats`). The business is
   * rendered as the thread header renders it for a customer: the mailbox
   * identity's own name, handle and avatar, with no staff first name.
   * The business's seats are `businessSeatUserIdsForViewer`'s, the set the
   * REST reaction counts and the live `reaction` frame collapse too.
   */
  async loadReactorView(
    conversationId: string,
    callerSeat: ConversationParticipant,
  ): Promise<ReactorView> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { id: true, kind: true, isOfficial: true },
    });
    if (!conversation) {
      return { shape: 'ownOnly' };
    }
    if (
      conversation.kind === ConversationKind.Group ||
      conversation.isOfficial
    ) {
      return { shape: 'individuals' };
    }
    const { threadSeats } = await this.loadDirectThreadSeats(
      conversationId,
      callerSeat,
    );
    if (threadSeats.isCallerMailboxSeat) {
      return { shape: 'individuals' };
    }
    const mailboxIdentityId = threadSeats.mailboxIdentityId;
    if (mailboxIdentityId) {
      const [mailboxIdentities, descriptionById] = await Promise.all([
        this.identities.getByIds([mailboxIdentityId]),
        this.identities.describeIdentities([mailboxIdentityId]),
      ]);
      const mailboxIdentity = mailboxIdentities[0];
      const description = descriptionById.get(mailboxIdentityId);
      return {
        shape: 'customerOfMailbox',
        businessUserIds: businessSeatUserIdsForViewer(threadSeats),
        business:
          mailboxIdentity && description
            ? buildAuthorSummary({
                identity: { id: mailboxIdentityId, kind: mailboxIdentity.kind },
                identityDisplayName: description.displayName,
                identityHandle: description.handle ?? '',
                identityAvatarUrl: description.avatarUrl,
                staffFirstName: null,
              })
            : FORMER_IDENTITY_AUTHOR,
      };
    }
    return threadSeats.hasUnresolvedSeatIdentity
      ? { shape: 'ownOnly' }
      : { shape: 'individuals' };
  }

  /**
   * Task 13c: the rendering context for a list of messages drawn from many
   * conversations (search hits, the starred list), for one viewer. Loads
   * every seat of those conversations, every identity those seats and
   * messages speak for, and every profile needed, in a fixed number of
   * batched queries, then renders each conversation's counterpart with the
   * inbox header's own `renderDirectCounterpart` and each message's sender
   * with the thread's own `renderMessageSender`.
   *
   * Final fix F1 (C1): it also gives each message row that carries its
   * `id`, `kind` and `attachment` the attachment every read renders
   * (`withMessageAttachmentRoute`), IN PLACE, so the callers' own
   * `resolveAttachment` of those rows (search hits, starred items) serves an
   * image or document sent as a business by its message reference, which
   * names no staff member. The rows are read-only results those callers
   * render and discard.
   */
  async loadMessageListContext(
    conversations: ReadonlyArray<
      Pick<Conversation, 'id' | 'kind' | 'isOfficial'>
    >,
    messages: ReadonlyArray<
      Pick<Message, 'senderId' | 'senderIdentityId'> &
        Partial<Pick<Message, 'id' | 'kind' | 'attachment'>>
    >,
    viewerId: string,
  ): Promise<{
    renderCounterpart: (conversationId: string) => AuthorSummary | null;
    renderSender: (
      message: Pick<Message, 'senderId' | 'senderIdentityId'>,
    ) => AuthorSummary;
  }> {
    const conversationIds = conversations.map(
      (conversation) => conversation.id,
    );
    const seats = conversationIds.length
      ? await this.participants.find({
          where: { conversationId: In(conversationIds) },
        })
      : [];
    const identityIds = [
      ...seats.map((seat) => seat.identityId),
      ...messages.flatMap((message) =>
        message.senderIdentityId ? [message.senderIdentityId] : [],
      ),
    ];
    const profileUserIds = [
      ...new Set([
        ...seats.map((seat) => seat.userId),
        ...presentSenderIds(messages),
      ]),
    ];
    const [profiles, senderIdentityContext] = await Promise.all([
      profileUserIds.length
        ? this.profiles.find({ where: { userId: In(profileUserIds) } })
        : Promise.resolve([]),
      loadSenderIdentityContext(
        {
          identities: this.identities,
          identityAttribution: this.identityAttribution,
        },
        identityIds,
        viewerId,
      ),
    ]);
    const profileByUser = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    for (const message of messages) {
      if (
        message.id !== undefined &&
        message.kind !== undefined &&
        message.attachment !== undefined
      ) {
        message.attachment = withMessageAttachmentRoute(
          {
            id: message.id,
            kind: message.kind,
            senderIdentityId: message.senderIdentityId,
            attachment: message.attachment,
          },
          senderIdentityContext.identityKindById,
        ).attachment;
      }
    }
    const counterpartByConversationId = new Map<string, AuthorSummary | null>();
    for (const conversation of conversations) {
      if (
        conversation.kind === ConversationKind.Group ||
        conversation.isOfficial
      ) {
        continue;
      }
      const conversationSeats = seats.filter(
        (seat) => seat.conversationId === conversation.id,
      );
      const callerSeat = conversationSeats.find(
        (seat) => seat.userId === viewerId,
      );
      const otherSeats = conversationSeats.filter(
        (seat) => seat.userId !== viewerId,
      );
      counterpartByConversationId.set(
        conversation.id,
        callerSeat
          ? renderDirectCounterpart(
              describeDirectThreadSeats(
                callerSeat.identityId,
                otherSeats,
                senderIdentityContext.identityKindById,
              ),
              senderIdentityContext.identityKindById,
              senderIdentityContext.identityDescriptionById,
              profileByUser,
            )
          : null,
      );
    }
    return {
      renderCounterpart: (conversationId) =>
        counterpartByConversationId.get(conversationId) ?? null,
      renderSender: (message) =>
        renderMessageSender(message, profileByUser, senderIdentityContext),
    };
  }

  /**
   * A business, persona or company only answers inside a thread a member
   * already opened. This is the whole of the reply-only rule, so it sits at
   * conversation creation, where every entry point already passes:
   * `getOrCreateConversation`, `messageRequest`, `deliverEnquiry` and group
   * creation.
   */
  async assertInitiatorIsProfile(identityId: string): Promise<void> {
    const identity = await this.identities.getById(identityId);
    if (!identity || identity.kind !== IdentityKind.Profile) {
      throw new ForbiddenException({
        code: 'IDENTITY_CANNOT_INITIATE',
        message: 'Only a member can start a conversation',
      });
    }
  }

  /**
   * The `created_at` of one message, scoped to the conversation it must belong
   * to, or `null` when it isn't there. Backs `markRead`'s explicit read
   * watermark (`upToMessageId`): the timestamp comes from the DB row, never
   * from the caller, so a client can neither stamp a watermark past what it
   * actually received nor point at another thread's message.
   */
  async messageCreatedAt(
    conversationId: string,
    messageId: string,
  ): Promise<Date | null> {
    const message = await this.messages.findOne({
      where: { id: messageId, conversationId },
      select: ['id', 'createdAt'],
      withDeleted: true,
    });
    return message?.createdAt ?? null;
  }

  /**
   * Whether a moderator has taken this message down (hidden OR removed).
   *
   * `toMessageResponses` already tombstones a taken-down message on every READ
   * path, but writes had no equivalent check: within the 15-minute edit window
   * the author of a just-hidden message could PATCH it, changing what
   * moderators see in the report and pushing the new body out live. Exposed
   * here (rather than duplicating the lookup) so `editMessage` reads the same
   * table, under the same subject key, as the read path.
   */
  isMessageTakenDown(messageId: string): Promise<boolean> {
    return this.moderationStates.exist({
      where: [
        {
          subjectType: MessagingCoreService.MESSAGE_SUBJECT_TYPE,
          subjectId: messageId,
          hiddenAt: Not(IsNull()),
        },
        {
          subjectType: MessagingCoreService.MESSAGE_SUBJECT_TYPE,
          subjectId: messageId,
          removedAt: Not(IsNull()),
        },
      ],
    });
  }

  /**
   * Whether a moderator takedown withholds this message from `viewerId`, under
   * the exact rule `toMessageResponses` tombstones by: a removal withholds it
   * from everyone, a hide only from non-staff. Staff is resolved the same way
   * that read path does (the viewer's platform role is Admin or Moderator), so
   * a per-message read route never refuses a message the thread shows staff.
   * Writes keep `isMessageTakenDown`, which counts a hide for everyone.
   */
  async isMessageWithheldFromViewer(
    messageId: string,
    viewerId: string,
  ): Promise<boolean> {
    const [moderation, viewer] = await Promise.all([
      this.moderationStates.findOne({
        where: {
          subjectType: MessagingCoreService.MESSAGE_SUBJECT_TYPE,
          subjectId: messageId,
        },
      }),
      this.usersService.findById(viewerId),
    ]);
    if (!moderation) return false;
    const viewerIsStaff =
      viewer?.role === UserRole.Admin || viewer?.role === UserRole.Moderator;
    return Boolean(
      moderation.removedAt ?? (viewerIsStaff ? null : moderation.hiddenAt),
    );
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
    return notModeratedMessagePredicate('m');
  }

  /**
   * A `NOT EXISTS` SQL fragment (message alias `m`) that is TRUE only when
   * `viewerId` has not "deleted for me" (PRD-227) this message. Shared by the
   * message-counting/preview query builders below so a per-viewer hide is
   * uniformly excluded from THIS viewer's preview/unread paths, without ever
   * touching what the other participant sees. The caller must bind the
   * `hiddenForUserId` parameter (`.setParameter('hiddenForUserId', viewerId)`).
   */
  private notHiddenForViewerPredicate(): string {
    return notHiddenForViewerMessagePredicate();
  }

  /** Newest message per conversation THIS viewer hasn't hidden (PRD-227), in
   *  one DISTINCT ON pass — so a viewer's own "delete for me" on their most
   *  recent message falls the inbox preview back to their own next-newest
   *  visible one, exactly as clearing a whole conversation already does. */
  async lastMessagesByConversation(
    convoIds: string[],
    viewerId: string,
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
      .andWhere(this.notHiddenForViewerPredicate())
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      .setParameter('hiddenForUserId', viewerId)
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
      // Task 15 fix round 1: a colleague's reply sent as the business is not
      // unread for this staff seat (`NOT_SENT_AS_SEAT_IDENTITY_PREDICATE`).
      .andWhere(NOT_SENT_AS_SEAT_IDENTITY_PREDICATE)
      .andWhere('(p.last_read_at IS NULL OR m.created_at > p.last_read_at)')
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      // leftAt ceiling, matching `MessagesService.getMessages`: a member
      // removed from a group cannot READ anything posted after they left, so
      // those messages must not keep driving an unread badge they can never
      // clear (BE-MSG-08).
      .andWhere('(p.left_at IS NULL OR m.created_at <= p.left_at)')
      // A moderator-taken-down message never counts toward unread — the viewer
      // can no longer see it, so it must not drive a badge.
      .andWhere(this.notModeratedPredicate())
      // A message THIS viewer "deleted for me" (PRD-227) never counts toward
      // their own unread badge either — it no longer exists for them.
      .andWhere(this.notHiddenForViewerPredicate())
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      .setParameter('hiddenForUserId', userId)
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string; count: string }>();
    return new Map(rows.map((r) => [r.conversationId, Number(r.count)]));
  }

  /**
   * How many of this user's conversations count as UNREAD, the single number
   * behind the nav DM badge (`GET /conversations/unread-count`), so the badge
   * never has to pull the whole inbox on every route.
   *
   * PRD-341: this is now THE single "unread thread" definition, shared with
   * the frontend's Unread tab (`threadFilters.ts`'s `isThreadUnread`) and the
   * row highlight (`messages.adapters.ts`'s `unread` field). A conversation
   * counts if it is NOT archived AND EITHER has a genuinely unread message
   * (the same per-message rules as `unreadCountsByConversation`: not the
   * caller's own, past their `last_read_at`/`cleared_at`/`left_at`
   * watermarks, never a moderated or self-hidden row) OR the caller
   * explicitly `markedUnreadAt` it (PRD-225) with nothing new to actually
   * read. Previously this only ever counted real unread MESSAGES, so a manual
   * mark-unread lit the row and filled the Unread tab but never moved this
   * badge, and an archived thread (which every OTHER tab hides, the All tab
   * included) could keep the badge lit forever with no row anywhere to clear
   * it from.
   */
  async unreadConversationCount(userId: string): Promise<number> {
    // Task 15: the scope itself lives in `applyUnreadConversationScope`, so
    // the mailbox switcher's per-identity counts
    // (`countUnreadConversationsByIdentity`) read the same definition.
    const raw = await applyUnreadConversationScope(
      this.participants
        .createQueryBuilder('p')
        .select('COUNT(DISTINCT p.conversation_id)', 'count'),
      userId,
    ).getRawOne<{ count: string }>();
    return Number(raw?.count ?? 0);
  }

  /**
   * PRD-348: does this user have at least one UNREAD message (same predicate
   * as `unreadCountsByConversation`: after their read/cleared/left
   * watermarks, from someone else, never a moderated or self-hidden row) in
   * each of these conversations that `@`-mentions them by their own profile
   * slug? Batched in ONE query for the whole inbox page, never one lookup
   * per row (the inbox list's N+1 rule).
   *
   * There is no dedicated "mentions" table for messages. A member mention is
   * persisted only as a best-effort `Notification` row
   * (`MentionNotificationService.notify`, fired once per SEND), which isn't
   * queryable back to "is this specific message still unread" without a
   * second join through its JSONB payload. Rather than add that join, this
   * re-derives the fact directly from the message body with the SAME token
   * shape `extractMentions` (`common/mentions.ts`) uses for the member
   * bucket: `@slug` at a whitespace/string-start boundary, lowercase only
   * (the extractor's char class carries no `i` flag, so an uppercase `@Sam`
   * is not a mention system-wide either), so this can never disagree with
   * whether the fan-out actually notified this member for the same text.
   */
  async hasUnreadMentionByConversation(
    convoIds: string[],
    userId: string,
    callerSlug: string | null | undefined,
  ): Promise<Map<string, boolean>> {
    if (!convoIds.length || !callerSlug) {
      return new Map();
    }
    // `(^|\s)@slug([^a-z0-9-]|$)` mirrors `extractMentions`'s member token
    // exactly: a boundary before the `@` (string start or whitespace, never
    // any other punctuation) and a boundary after the slug (a non-slug
    // character or the end of the body), so "@sam" doesn't false-match inside
    // "@samantha". Postgres `~` is case-SENSITIVE, matching the extractor's
    // own lowercase-only char class.
    const mentionPattern = `(^|\\s)@${callerSlug}([^a-z0-9-]|$)`;
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.conversation_id', 'conversationId')
      .innerJoin(
        ConversationParticipant,
        'p',
        'p.conversation_id = m.conversation_id AND p.user_id = :userId',
        { userId },
      )
      .where('m.conversation_id IN (:...convoIds)', { convoIds })
      .andWhere('m.sender_id != :userId', { userId })
      .andWhere(NOT_SENT_AS_SEAT_IDENTITY_PREDICATE)
      .andWhere('(p.last_read_at IS NULL OR m.created_at > p.last_read_at)')
      .andWhere('(p.cleared_at IS NULL OR m.created_at > p.cleared_at)')
      .andWhere('(p.left_at IS NULL OR m.created_at <= p.left_at)')
      .andWhere(this.notModeratedPredicate())
      .andWhere(this.notHiddenForViewerPredicate())
      .andWhere('m.body ~ :mentionPattern', { mentionPattern })
      .setParameter(
        'messageSubjectType',
        MessagingCoreService.MESSAGE_SUBJECT_TYPE,
      )
      .setParameter('hiddenForUserId', userId)
      .groupBy('m.conversation_id')
      .getRawMany<{ conversationId: string }>();
    return new Map(rows.map((r) => [r.conversationId, true]));
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
    const allReactionRows = await this.reactions.find({
      where: { messageId: In(messageIds) },
    });
    // Task 13e: a customer reading a business mailbox thread counts the
    // business once per key, whichever of its staff reacted, the same count
    // the live `reaction` frame and the "who reacted" list give.
    const reactionRows = await this.collapseBusinessReactionsForViewer(
      allReactionRows,
      viewerId,
    );
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
   * Task 13e: `reactionRows` as `viewerId` counts them. Every row of a
   * message in a thread where `businessSeatUserIdsForViewer` names a
   * business for this viewer goes through `collapseBusinessReactions`; any
   * other row is returned as it is. Costs nothing when there are no rows,
   * and otherwise one query for the messages' conversations plus
   * `businessSeatUserIdsByConversation`'s own.
   */
  private async collapseBusinessReactionsForViewer(
    reactionRows: MessageReaction[],
    viewerId: string,
  ): Promise<MessageReaction[]> {
    if (!reactionRows.length) {
      return reactionRows;
    }
    const reactedMessages = await this.messages.find({
      where: { id: In([...new Set(reactionRows.map((row) => row.messageId))]) },
      select: { id: true, conversationId: true },
      withDeleted: true,
    });
    const conversationIdByMessage = new Map(
      reactedMessages.map((message) => [message.id, message.conversationId]),
    );
    const businessUserIdsByConversation =
      await this.businessSeatUserIdsByConversation(
        [...new Set(conversationIdByMessage.values())],
        viewerId,
      );
    if (businessUserIdsByConversation.size === 0) {
      return reactionRows;
    }
    const rowsByMessage = new Map<string, MessageReaction[]>();
    for (const row of reactionRows) {
      rowsByMessage.set(row.messageId, [
        ...(rowsByMessage.get(row.messageId) ?? []),
        row,
      ]);
    }
    return [...rowsByMessage].flatMap(([messageId, rows]) => {
      const conversationId = conversationIdByMessage.get(messageId);
      const businessUserIds = conversationId
        ? businessUserIdsByConversation.get(conversationId)
        : undefined;
      return businessUserIds
        ? collapseBusinessReactions(rows, businessUserIds)
        : rows;
    });
  }

  /**
   * Task 13e: for each DIRECT, non-official conversation in
   * `conversationIds` where `viewerId` holds a seat, the business seat set
   * `businessSeatUserIdsForViewer` gives from that seat. Conversations with
   * an empty set are left out. Three batched queries whatever the count.
   */
  async businessSeatUserIdsByConversation(
    conversationIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReadonlySet<string>>> {
    const businessUserIdsByConversation = new Map<
      string,
      ReadonlySet<string>
    >();
    if (!conversationIds.length) {
      return businessUserIdsByConversation;
    }
    const directConversationIds = (
      await this.conversations.find({
        where: { id: In(conversationIds) },
        select: { id: true, kind: true, isOfficial: true },
      })
    )
      .filter(
        (conversation) =>
          conversation.kind !== ConversationKind.Group &&
          !conversation.isOfficial,
      )
      .map((conversation) => conversation.id);
    if (!directConversationIds.length) {
      return businessUserIdsByConversation;
    }
    const seats = await this.participants.find({
      where: { conversationId: In(directConversationIds) },
      select: { conversationId: true, userId: true, identityId: true },
    });
    const seatIdentities = await this.identities.getByIds([
      ...new Set(seats.map((seat) => seat.identityId)),
    ]);
    const identityKindById = new Map(
      seatIdentities.map((identity) => [identity.id, identity.kind]),
    );
    for (const conversationId of directConversationIds) {
      const threadSeats = seats.filter(
        (seat) => seat.conversationId === conversationId,
      );
      const viewerSeat = threadSeats.find((seat) => seat.userId === viewerId);
      if (!viewerSeat) {
        continue;
      }
      const businessUserIds = businessSeatUserIdsForViewer(
        describeDirectThreadSeats(
          viewerSeat.identityId,
          threadSeats.filter((seat) => seat !== viewerSeat),
          identityKindById,
        ),
      );
      if (businessUserIds.size > 0) {
        businessUserIdsByConversation.set(conversationId, businessUserIds);
      }
    }
    return businessUserIdsByConversation;
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
    // PRD-355: the caller this preview is being built FOR, so a system pill's
    // `actorIsMe`/`targetIsMe` are correct even in an inbox row (e.g. "You
    // created the group" for the creator, "Ana created the group" for
    // everyone else). Optional purely so a call site that has not been
    // threaded through yet keeps compiling; see `buildSystemEvent`'s own doc.
    viewerId?: string,
    // Task 13c: the viewer's identity context, so a message sent AS a
    // business previews as the business, exactly as `toMessageResponses`
    // renders it in the thread (`renderMessageSender`). Every direct-thread
    // caller passes one. Omitted only by the GROUP callers, whose senders
    // always speak as their own profile: `assertMaySendAs` requires the
    // sending identity to hold a seat, and every group seat is a profile.
    senderIdentityContext?: SenderIdentityContext,
    // Task 23 cleanup: the identity of the viewer's own seat in this thread,
    // so the `moved_to_business_mailbox` note previews exactly as the thread
    // renders it (`withMovedNoteMailbox`): staff of the business keep the
    // owner as its actor, and every other viewer reads the business itself.
    // A caller that passes no seat or no identity context previews the note
    // with the business as its actor, the customer's rendering.
    viewerSeatIdentityId?: string,
  ): ViewerMessageResponse {
    const isSystem = message.kind === MessageKind.System;
    // Final fix F1 (C1): an image or document sent as a business previews by
    // its message reference, exactly as the thread renders it. A group
    // caller passes no identity context, and every group sender speaks as
    // their own profile.
    const previewAttachment = senderIdentityContext
      ? withMessageAttachmentRoute(
          message,
          senderIdentityContext.identityKindById,
        ).attachment
      : message.attachment;
    return {
      id: message.id,
      conversationId,
      body: message.body,
      sender: senderIdentityContext
        ? renderMessageSender(message, profileByUser, senderIdentityContext)
        : senderAuthorSummary(message.senderId, profileByUser),
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
      attachment: resolveAttachment(previewAttachment),
      systemEvent: isSystem
        ? withMovedNoteMailbox(
            buildSystemEvent(message.systemEvent, profileByUser, viewerId),
            {
              viewerSeatIdentityId,
              identityDescriptionById:
                senderIdentityContext?.identityDescriptionById ?? new Map(),
            },
          )
        : null,
      // Final fix F1 (B2): the inbox row carries `isSentByViewer` under the
      // thread's own rule (`isSentByViewerField`), so staff of the business
      // read "You:" on a reply they typed themselves, as the thread shows
      // it. A customer, a personal message and a system row get no key.
      // `isGroupOrOfficialConversation` is false here because this path
      // needs no flag: a group caller passes no identity context, and a
      // group or official thread's sender speaks as a profile, for which
      // the rule returns no key.
      ...(senderIdentityContext && viewerId
        ? isSentByViewerField(message, {
            viewerId,
            viewerSeatIdentityId,
            identityKindById: senderIdentityContext.identityKindById,
            identityDescriptionById:
              senderIdentityContext.identityDescriptionById,
            isGroupOrOfficialConversation: false,
          })
        : {}),
    };
  }

  /**
   * The active (not-left) roster of a group thread, as `ConversationMemberSummary`
   * rows — owner first, then admins, then members, each alphabetical-stable by
   * insertion. A left participant is excluded from the roster and the count (they
   * keep read access but are no longer "in" the group). Profiles come from the
   * pre-batched map; a missing one falls back to the generic placeholder name.
   *
   * PRD-364: `lastReadAt` is reciprocal read-receipt state, so it is withheld
   * (null) for any member whose own `shareReadReceipts` is off (their read
   * watermark must not leak to the rest of the group), AND for every row when
   * `viewerId` (this caller) has turned their OWN sharing off (a member who
   * stops sharing also stops seeing everyone else's watermark) — except the
   * viewer's own row, which is never someone else's read state to begin with
   * and stays visible to them. `privacyByUser` is caller-batched (never one
   * query per member); an id absent from it (no row) reads as sharing on, the
   * same default `PreferencesService.getMessagingPrivacyForUsers` applies.
   * `deliveredAt` is untouched — delivery receipts are out of PRD-364's scope.
   */
  buildMemberSummaries(
    participants: ConversationParticipant[],
    profileByUser: Map<string, Profile>,
    viewerId: string,
    privacyByUser: Map<string, MessagingPrivacyDTO>,
  ): ConversationMemberSummary[] {
    const rank: Record<ConversationRole, number> = {
      [ConversationRole.Owner]: 0,
      [ConversationRole.Admin]: 1,
      [ConversationRole.Member]: 2,
    };
    const viewerSharesReadReceipts =
      privacyByUser.get(viewerId)?.shareReadReceipts ?? true;
    return participants
      .filter((participant) => participant.leftAt == null)
      .map((participant) => {
        const summary = requireAuthorSummary(
          profileByUser.get(participant.userId),
        );
        const isViewerRow = participant.userId === viewerId;
        const subjectSharesReadReceipts =
          privacyByUser.get(participant.userId)?.shareReadReceipts ?? true;
        const withholdReadState =
          !isViewerRow &&
          (!viewerSharesReadReceipts || !subjectSharesReadReceipts);
        return {
          id: participant.userId,
          handle: summary.handle,
          name: summary.displayName,
          avatarUrl: summary.avatarUrl,
          role: participant.role,
          // Per-member watermarks for group "Seen by N" — the client compares
          // each member's read watermark against a message's createdAt without
          // an N+1 per-message receipts endpoint.
          lastReadAt: withholdReadState
            ? null
            : (participant.lastReadAt?.toISOString() ?? null),
          deliveredAt: participant.deliveredAt?.toISOString() ?? null,
          // PRD-351: the real read INSTANT alongside the watermark above,
          // withheld under the identical `withholdReadState` gate. It is
          // just as much a read receipt as `lastReadAt` and must leak under
          // the exact same conditions, never more or less.
          lastReadInstant: withholdReadState
            ? null
            : (participant.lastReadInstant?.toISOString() ?? null),
        };
      })
      .sort((a, b) => rank[a.role] - rank[b.role]);
  }

  /**
   * ENG-253: the lightweight avatar-stack preview `ConversationResponse.
   * memberPreview` sends on EVERY row (list and single-conversation alike),
   * INSTEAD of the full `members` roster on a list row. Active members only
   * (mirrors `buildMemberSummaries`), capped at `MAX_MEMBER_PREVIEW`, enough
   * for any avatar stack, never the group's real membership ceiling
   * (`MAX_GROUP_MEMBERS`). Carries no role or read/delivered watermark: those
   * are exactly the fields the inbox list never rendered and no longer ships.
   */
  buildMemberPreview(
    participants: ConversationParticipant[],
    profileByUser: Map<string, Profile>,
  ): ConversationMemberPreview[] {
    return participants
      .filter((participant) => participant.leftAt == null)
      .slice(0, MAX_MEMBER_PREVIEW)
      .map((participant) => {
        const summary = requireAuthorSummary(
          profileByUser.get(participant.userId),
        );
        return {
          id: participant.userId,
          handle: summary.handle,
          name: summary.displayName,
          avatarUrl: summary.avatarUrl,
        };
      });
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
   *
   * `hasViewerLeftConversation` (default `false`, matching the historically
   * lenient behaviour for a caller that cannot yet supply it, see ENG-254)
   * is the caller's own `ConversationParticipant.leftAt` truth for THIS page's
   * one conversation: `canPin`/`canEdit` must mirror `pinMessage`/
   * `unpinMessage`/`editMessage`'s own `requireActiveParticipant` guard
   * exactly, so a member who left (or was removed from) a group is never
   * offered an action the endpoint would then reject with a 403. `canDelete`
   * deliberately does NOT read this flag: `deleteMessage` keeps the lenient
   * `requireParticipant` check (removing your own content stays possible
   * after you leave), and `canReport`'s endpoint has no participant
   * requirement at all.
   *
   * ENG-240: `canPin` also withholds Pin from a GROUP viewer who is not
   * owner/admin, mirroring `MessageAnnotationsService.assertCanManageGroupPins`
   * — looked up here (one extra pair of batched, page-level queries) rather
   * than threaded through every caller as another parameter.
   */
  async toMessageResponses(
    rows: MessageLike[],
    viewerId: string,
    hasViewerLeftConversation = false,
    // ENG-240 hot-path fix: `getMessages` (and every other caller that has
    // already looked up the conversation for its own reasons) can pass the
    // kind straight through, so this method skips its own `conversations`
    // lookup entirely. Left undefined by callers that have not looked it up
    // yet, in which case the fallback `findOne` below runs exactly as before.
    conversationKind?: ConversationKind,
    // Final review I2: `renderMessageForViewerClasses` passes a loader that
    // shares the identity rows, staff and preferences across the classes it
    // renders. Every other caller loads them for this call alone.
    loadSenderIdentities: (
      identityIds: string[],
      readerUserId: string,
    ) => Promise<SenderIdentityContext> = (identityIds, readerUserId) =>
      loadSenderIdentityContext(
        {
          identities: this.identities,
          identityAttribution: this.identityAttribution,
        },
        identityIds,
        readerUserId,
      ),
  ): Promise<ViewerMessageResponse[]> {
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
    // `presentSenderIds` drops the NULL sender of an erased author (ENG-243),
    // who has no profile to load and renders as a former member.
    const senderIds = [
      ...new Set([
        ...presentSenderIds(rows),
        ...presentSenderIds(parents),
        ...systemUserIds,
      ]),
    ];
    // Fix round 1 (Task 11): every distinct identity this page's OWN rows
    // were sent as, so the batch below costs the same one-time fixed price
    // whether this page holds one message or fifty. Task 13c: the reply
    // parents' sender identities ride the same batch, so a quote of a
    // business reply names the business (see `replyTo` below). System actors
    // still render off their author's plain profile.
    const senderIdentityIds = [
      ...new Set(
        [...rows, ...parents]
          .map((m) => m.senderIdentityId)
          .filter((identityId): identityId is string => identityId != null),
      ),
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
      // ENG-240 hot-path fix: EVERY participant row for this conversation
      // (viewer included), one query. `viewerParticipant`/`otherParticipantRows`
      // below are split out of this single result in memory instead of each
      // running their own query (the viewer's row no longer needs its own
      // `participants.findOne`, and the non-viewer rows below are filtered
      // from the same array rather than re-querying with `userId: Not(viewerId)`).
      allParticipantRows,
      pinRows,
      starRows,
      viewer,
      moderationRows,
      viewerHiddenReplyParentRows,
      resolvedConversationKind,
      // Fix round 1 (Task 11): this page's sender identities, kind-resolved
      // and display-resolved, and one `StaffNameResolver` covering every one
      // of them for THIS viewer, so a business sender renders as itself with
      // no per-message query. Task 13c: loaded through the shared
      // `loadSenderIdentityContext`, the same loader the inbox preview uses.
      senderIdentityContext,
    ] = await Promise.all([
      this.profiles.find({ where: { userId: In(senderIds) } }),
      this.reactionSummariesByMessage(messageIds, viewerId),
      this.participants.find({ where: { conversationId } }),
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
      // The reply parents' takedowns ride along in the same query, so a quote
      // of a taken-down message is withheld without a second lookup.
      this.moderationStates.find({
        where: {
          subjectType: MessagingCoreService.MESSAGE_SUBJECT_TYPE,
          subjectId: In([...new Set([...messageIds, ...replyIds])]),
        },
      }),
      // THIS viewer's own PRD-227 "delete for me" on this page's reply
      // parents, in one `IN(...)` query, never a per-message lookup. Without
      // this, a reply that quotes a message the viewer hid for themself still
      // leaked that parent's real snippet, sender, thumbnail and file name
      // through `buildReplyTo`, even though the viewer can no longer see the
      // parent anywhere else in the thread. Skipped entirely when this page
      // has no reply ids.
      replyIds.length
        ? this.hides.find({
            where: { userId: viewerId, messageId: In(replyIds) },
          })
        : Promise.resolve([]),
      // ENG-240 hot-path fix: only look the conversation's kind up here when
      // the caller hasn't already (the fallback for a caller that never
      // looked it up); `getMessages` and friends now pass `conversationKind`
      // straight through, since they already loaded it for their own
      // block-filter branching, so this resolves with no extra query at all.
      conversationKind !== undefined
        ? Promise.resolve(conversationKind)
        : this.conversations
            .findOne({ where: { id: conversationId }, select: { kind: true } })
            .then((found) => found?.kind ?? null),
      // Task 23: the businesses this page's moved notes name ride the same
      // batch, so a note costs no query of its own.
      loadSenderIdentities(
        [...senderIdentityIds, ...movedNoteMailboxIdentityIds(rows)],
        viewerId,
      ),
    ]);
    const viewerIsStaff =
      viewer?.role === UserRole.Admin || viewer?.role === UserRole.Moderator;
    // ENG-240 hot-path fix: the viewer's OWN participant row, split out of
    // `allParticipantRows` in memory rather than its own `participants.findOne`
    // (see that array's own comment above). Used only to gate `canPin` in a
    // GROUP (owner/admin only).
    const viewerParticipant =
      allParticipantRows.find((row) => row.userId === viewerId) ?? null;
    // Only PRESENT recipients count toward "delivered to all" — every OTHER
    // (non-viewer) row, exactly what the old `userId: Not(viewerId)` query
    // returned, now filtered from the same `allParticipantRows` fetch above.
    const otherParticipantRows = allParticipantRows.filter(
      (row) => row.userId !== viewerId,
    );
    // ENG-240: `pinMessage`/`unpinMessage` refuse a GROUP viewer who is not
    // owner/admin (`MessageAnnotationsService.assertCanManageGroupPins`); a
    // DM has no such restriction. `viewerParticipant` can be null only for a
    // page whose viewer somehow has no participant row for this
    // conversation (treated as "not owner/admin", fails closed).
    const viewerCanManageGroupPins =
      resolvedConversationKind !== ConversationKind.Group ||
      viewerParticipant?.role === ConversationRole.Owner ||
      viewerParticipant?.role === ConversationRole.Admin;
    // ENG-254: `pinMessage`/`unpinMessage`/`editMessage` all gate on
    // `requireActiveParticipant`, not the lenient `requireParticipant` a read
    // uses, a member who left (or was removed from) the group may still
    // read the thread but may not act in it. Mirrored here so a former
    // member is never offered Pin, or Edit inside the window, only to have
    // the endpoint 403 the action the overlay just promised. Conversation-
    // level, not per-message, so it is computed once for the whole page.
    const isViewerActiveParticipant = !hasViewerLeftConversation;
    // subjectId -> its takedown row, so each message can resolve the tombstone
    // timestamp its `deletedAt` will carry.
    const moderationByMessage = new Map(
      moderationRows.map((row) => [row.subjectId, row]),
    );
    const viewerHiddenReplyParentIds = new Set(
      viewerHiddenReplyParentRows.map((hide) => hide.messageId),
    );
    // Reply parents quoted as deleted: either a moderator took the parent down
    // (under the exact removed/hidden split the parent's own bubble uses
    // below, so a quote never carries a snippet, thumbnail or file name the
    // thread itself withholds), or THIS viewer hid the parent for themself
    // (PRD-227), same "unavailable" quote either way.
    const hiddenReplyParentIds = new Set(
      replyIds.filter((parentId) => {
        const moderation = moderationByMessage.get(parentId);
        const isModeratedAwayFromViewer = Boolean(
          moderation &&
          (moderation.removedAt ??
            (viewerIsStaff ? null : moderation.hiddenAt)),
        );
        return (
          isModeratedAwayFromViewer || viewerHiddenReplyParentIds.has(parentId)
        );
      }),
    );
    // Task 13h: when THIS viewer's seat is a mailbox staff seat with a
    // history floor (a co-manager of a thread moved into a business
    // mailbox), a parent at or before the floor does not exist for them, so
    // a later reply quoting it renders the missing-parent quote: `deleted`,
    // with no snippet, sender name, thumbnail or file name, and the generic
    // `user` kind. It is left out of the map `buildReplyTo` and the
    // business-name renaming below read, which keeps the parent's author off
    // the quote too. Compared in SQL through
    // `mailboxStaffHistoryFloorCoversPredicate`, so a personal or group
    // "clear chat" keeps quoting as before. The query runs only for a viewer
    // with a floor on a page that quotes something.
    const flooredParentIds =
      viewerParticipant?.clearedAt && parents.length > 0
        ? new Set(
            (
              await this.messages
                .createQueryBuilder('parent')
                .withDeleted()
                .select('parent.id', 'parentId')
                .innerJoin(
                  ConversationParticipant,
                  'seat',
                  'seat.id = :viewerSeatId',
                  { viewerSeatId: viewerParticipant.id },
                )
                .where('parent.id IN (:...parentIds)', {
                  parentIds: parents.map((parent) => parent.id),
                })
                .andWhere(
                  mailboxStaffHistoryFloorCoversPredicate(
                    'parent.created_at',
                    'seat',
                  ),
                )
                .getRawMany<{ parentId: string }>()
            ).map((row) => row.parentId),
          )
        : new Set<string>();
    // Final fix F1 (C1): a quoted parent sent as a business carries its
    // message reference, so the quote's thumbnail names no staff member.
    const quotableParentById = new Map(
      [...parentById]
        .filter(([parentId]) => !flooredParentIds.has(parentId))
        .map(([parentId, parent]): [string, Message] => [
          parentId,
          withMessageAttachmentRoute(
            parent,
            senderIdentityContext.identityKindById,
          ),
        ]),
    );
    const pinnedAtByMessage = new Map(
      pinRows.map((pin) => [pin.messageId, pin.pinnedAt]),
    );
    const starredMessageIds = new Set(starRows.map((star) => star.messageId));
    // Only PRESENT recipients count toward "delivered to all" — a member who left
    // a group will never ack, so including them would peg the tick at one check
    // forever. For a 1:1 DM this is just the single counterpart.
    //
    // Task 13c: in a direct thread, a seat sharing the viewer's own identity
    // is a colleague on the same side of a business mailbox, so it is never
    // a recipient. When every remaining recipient speaks for ONE identity
    // (the staff seats of a business, read by its customer), the business
    // counts as having received a message the moment ANY of its seats has,
    // the LATEST watermark, matching the inbox's own `otherDeliveredAt`.
    // Taking the earliest there would tie the customer's ticks to the least
    // active staff member, and a newly seated colleague who has acked
    // nothing would turn every earlier message back to one tick, showing the
    // customer a change in the roster.
    const viewerIdentityId = viewerParticipant?.identityId;
    const presentRecipients = otherParticipantRows.filter(
      (row) =>
        row.leftAt == null &&
        (resolvedConversationKind === ConversationKind.Group ||
          viewerIdentityId === undefined ||
          row.identityId !== viewerIdentityId),
    );
    const isOneRecipientIdentity =
      resolvedConversationKind !== ConversationKind.Group &&
      presentRecipients.length > 0 &&
      presentRecipients.every(
        (row) => row.identityId === presentRecipients[0]!.identityId,
      );
    const deliveredWatermarks = presentRecipients
      .map((row) => row.deliveredAt)
      .filter((value): value is Date => value != null);
    // "Delivered to all present recipients": every present non-viewer participant
    // must have acked, then take the EARLIEST of their watermarks (for a 1:1 DM
    // that is just the single counterpart's). One recipient identity: the
    // LATEST acked watermark, see above.
    const otherDeliveredAt: Date | null =
      isOneRecipientIdentity && deliveredWatermarks.length > 0
        ? deliveredWatermarks.reduce((latest, value) =>
            value > latest ? value : latest,
          )
        : presentRecipients.length > 0 &&
            deliveredWatermarks.length === presentRecipients.length
          ? deliveredWatermarks.reduce((earliest, value) =>
              value < earliest ? value : earliest,
            )
          : null;
    const profileByUser = new Map(senders.map((p) => [p.userId, p]));
    const responses = rows.map((m): MessageResponse => {
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
      // ENG-241: a system pill's `senderId` is the ACTOR of the audited event
      // ("X removed Y"), not a real author who wrote a body, it must never
      // be offered as an editable/deletable message of its own, no matter how
      // recent or who the viewer is.
      const isSystemMessage = m.kind === MessageKind.System;
      // Fix round 1 (Task 11), corrected in fix round 2: a business/persona/
      // company sender renders as the identity itself, with the staff first
      // name alongside only when attribution allows it for THIS viewer. Task
      // 13c moved the rule into the shared `renderMessageSender`, where its
      // full reasoning lives, so the inbox preview, search and the starred
      // list render a sender exactly as the thread does.
      const sender = renderMessageSender(
        m,
        profileByUser,
        senderIdentityContext,
      );
      // Task 13c: `buildReplyTo` names a quoted parent after its human
      // author's profile. A parent sent AS a business is quoted under the
      // business's own name, through the same renderer as the parent's own
      // bubble, so replying to a business message never shows the customer
      // the staff member who typed it.
      const plainReplyTo = buildReplyTo(
        m.replyToId,
        quotableParentById,
        profileByUser,
        hiddenReplyParentIds,
      );
      const replyParent = m.replyToId
        ? quotableParentById.get(m.replyToId)
        : undefined;
      const replyParentSenderIdentityKind = replyParent?.senderIdentityId
        ? senderIdentityContext.identityKindById.get(
            replyParent.senderIdentityId,
          )
        : undefined;
      const replyTo =
        plainReplyTo &&
        replyParent?.senderId &&
        replyParent.senderIdentityId &&
        replyParentSenderIdentityKind !== IdentityKind.Profile
          ? {
              ...plainReplyTo,
              senderName: renderMessageSender(
                replyParent,
                profileByUser,
                senderIdentityContext,
              ).displayName,
            }
          : plainReplyTo;
      return {
        id: m.id,
        conversationId: m.conversationId,
        body: isDeleted ? '' : m.body,
        sender,
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
        // `pinMessage` requires an ACTIVE participant (see
        // `isViewerActiveParticipant` above), this flag would otherwise offer
        // Pin to a member who already left the group. ENG-240:
        // `viewerCanManageGroupPins` additionally withholds it from a GROUP
        // viewer who is not owner/admin.
        canPin:
          !isDeleted && isViewerActiveParticipant && viewerCanManageGroupPins,
        // Mirrors `MessagesService.editMessage`/`deleteMessage`'s own guards
        // exactly (active participant + author + window; author-or-staff, no
        // active-participant requirement, `deleteMessage` keeps the lenient
        // check on purpose) so the client never offers an action the endpoint
        // would then reject. Both exclude a system pill (ENG-241): its
        // `senderId` is the audited event's ACTOR, not an author with a real
        // body to edit or delete. `canReport` excludes the author's own
        // messages. PRD-361: a message deleted for everyone stays reportable
        // while its evidence hold runs (the server still has its body and
        // bytes), so a harasser cannot unsend their way out of a report; a
        // moderator takedown (hidden or removed) is never reportable again,
        // and neither is a tombstone whose hold has ended. `POST /reports`
        // requires the reporter to have been a participant when the message
        // was sent (PRD-368), which a viewer of this page already was, so this
        // is deliberately NOT gated on `isViewerActiveParticipant`.
        canEdit:
          !isDeleted &&
          !isSystemMessage &&
          isAuthor &&
          withinEditWindow &&
          isViewerActiveParticipant,
        canDelete:
          !isDeleted && !isSystemMessage && (isAuthor || viewerIsStaff),
        canReport:
          !isAuthor &&
          (!isDeleted ||
            (Boolean(m.deletedAt) &&
              !moderation?.removedAt &&
              !moderation?.hiddenAt &&
              isEvidenceHoldActive(m.attachmentPurgeAfter))),
        replyTo,
        // Timeline kind + resolved system event. A `user` message carries a null
        // event; a `system` one resolves actor/target ids to display names so the
        // client renders bilingual templates ("You created the group", "Ana
        // added Bea") without ever seeing a user id.
        kind: messageKindToResponseKind(m.kind),
        // Final fix F1 (C1): an image or document sent as a business,
        // persona or company is rendered by its message reference
        // (`withMessageAttachmentRoute`), the same URL for every viewer, so
        // the storage key naming the staff member who uploaded it never
        // reaches the thread, the gallery, the pins or a live frame.
        attachment: isDeleted
          ? null
          : resolveAttachment(
              withMessageAttachmentRoute(
                m,
                senderIdentityContext.identityKindById,
              ).attachment,
            ),
        systemEvent:
          m.kind === MessageKind.System
            ? buildSystemEvent(m.systemEvent, profileByUser, viewerId)
            : null,
      };
    });
    // Task 23: the per-viewer fields, added once every response is built.
    // `isSentByViewer` tells staff of the sending business their own
    // replies from a colleague's, and the moved note names the business,
    // with the business as its actor for anyone outside its staff. Both
    // read the viewer's own seat and the identity batch above.
    // Task 23 cleanup: `isSentByViewer` is left off a group or official
    // thread whatever its seats hold. The official flag costs a query only
    // when the viewer's seat speaks for a business, the one case in which a
    // row of this page could carry the key, so a personal or group page
    // reads nothing more.
    const viewerSeatIdentityKind = viewerIdentityId
      ? senderIdentityContext.identityKindById.get(viewerIdentityId)
      : undefined;
    const isGroupOrOfficialConversation =
      resolvedConversationKind === ConversationKind.Group ||
      (viewerSeatIdentityKind !== undefined &&
        viewerSeatIdentityKind !== IdentityKind.Profile &&
        (await this.isOfficialConversation(conversationId)));
    const viewerMessageContext = {
      viewerId,
      viewerSeatIdentityId: viewerIdentityId,
      identityKindById: senderIdentityContext.identityKindById,
      identityDescriptionById: senderIdentityContext.identityDescriptionById,
      isGroupOrOfficialConversation,
    };
    return responses.map((response, index) =>
      toViewerMessageResponse(response, rows[index]!, viewerMessageContext),
    );
  }

  /**
   * Final review I2: `message` as `toMessageResponses` renders it for each
   * of `viewerIds`, rendered once per class of viewers whose inputs to that
   * method are identical (`renderMessageByViewerClass`). A live frame on a
   * business thread reaches every staff member, and this keeps its cost
   * flat in the staff count. `keyComponents` exists for the equivalence
   * spec; every caller leaves it at its default.
   */
  renderMessageForViewerClasses(
    message: MessageLike,
    viewerIds: ReadonlyArray<string>,
    conversationKind: ConversationKind,
    onRenderError: (error: unknown) => void,
    keyComponents?: ReadonlyArray<ViewerRenderClassKeyComponent>,
  ): Promise<Map<string, ViewerMessageResponse>> {
    return renderMessageByViewerClass(
      {
        participants: this.participants,
        messages: this.messages,
        reactions: this.reactions,
        stars: this.stars,
        hides: this.hides,
        users: this.dataSource.getRepository(User),
        identities: this.identities,
        identityAttribution: this.identityAttribution,
        render: async (row, viewerId, loadSenderIdentities) =>
          (
            await this.toMessageResponses(
              [row],
              viewerId,
              false,
              conversationKind,
              loadSenderIdentities,
            )
          )[0],
      },
      message,
      viewerIds,
      onRenderError,
      keyComponents,
    );
  }

  /** Whether `conversationId` is an official thread. A missing row reads
   *  as false. */
  private async isOfficialConversation(
    conversationId: string,
  ): Promise<boolean> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { isOfficial: true },
    });
    return conversation?.isOfficial ?? false;
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
    kind?: 'user' | 'gif' | 'image' | 'document' | 'sticker',
    attachment?: AttachmentInput,
    stickerId?: string,
    asIdentityId?: string,
  ): Promise<{ view: MessageView; response: MessageResponse; isNew: boolean }> {
    if (clientMessageId) {
      const existing = await this.messages.findOne({
        where: { conversationId, clientMessageId },
        withDeleted: true,
      });
      if (existing) {
        this.assertOwnIdempotencyKey(existing, senderId);
        return this.buildPostResult(existing, senderId, false);
      }
    }
    // Task 7: the identity this message is sent AS, defaulting to the
    // sender's own profile identity when nobody chose a business one. Both
    // questions `assertMaySendAs` answers must hold before anything below is
    // validated or persisted: this call sits before every other check in this
    // method precisely so a refused identity leaves no row behind.
    const senderIdentityId =
      asIdentityId ??
      (await this.identities.resolveProfileIdentityId(senderId));
    // Final fix F1 (C3): the house account posts every official message and
    // broadcast, and it holds no seat in any official thread by design
    // (`OfficialConversationsService`), so the seat half of the guard would
    // refuse every one of them. That one refusal is waived, only for a send
    // with no chosen identity, by the house account itself, into an official
    // thread (`isHouseAccountOfficialSend`). The lookup runs only on that
    // refusal, so an ordinary send reads nothing more, and every other
    // sender without a seat is still refused.
    await this.assertMaySendAs(
      conversationId,
      senderId,
      senderIdentityId,
    ).catch(async (error: unknown) => {
      if (
        asIdentityId === undefined &&
        isIdentityNotInConversationError(error) &&
        (await this.isHouseAccountOfficialSend(conversationId, senderId))
      ) {
        return;
      }
      throw error;
    });
    // Task 23 (spec 4.3): a reply sent as a business, persona or company
    // identity claims an unclaimed thread for its sender. A send with no
    // chosen identity speaks as the sender's own profile and needs no read.
    const shouldClaimOnReply =
      asIdentityId !== undefined &&
      (await this.isMailboxIdentity(senderIdentityId));
    if (
      (kind === 'gif' || kind === 'image' || kind === 'document') &&
      !attachment
    ) {
      throw new BadRequestException(
        `attachment is required for a ${kind} message`,
      );
    }
    // Defence in depth: `attachment.provider` is free-form client input
    // (`GifAttachmentDto.provider`'s only bound is `@IsString()
    // @MaxLength(32)`), and the gif/image/document branches below copy it
    // verbatim into the stored attachment. Left unchecked, a forged
    // `provider: 'sticker'` on an ordinary photo/GIF/document would persist
    // on a row the tightened `isStickerAttachment`
    // (`entities/message.entity.ts`) now refuses to read back as a real
    // sticker anywhere, corrupting reply quotes, moderation evidence, and
    // exports for that row. A legitimate client never sends this
    // combination, so this is a plain 400.
    if (
      (kind === 'gif' || kind === 'image' || kind === 'document') &&
      attachment?.provider === 'sticker'
    ) {
      throw new BadRequestException(
        `attachment.provider cannot be "sticker" for a ${kind} message`,
      );
    }
    // Narrowed from the loose wire-level `AttachmentInput` (see its own doc —
    // one DTO class carries every kind's fields, all but `url`/`provider`
    // optional) to a fully-typed, ready-to-persist attachment once the branch
    // below validates it against the specific fields ITS kind requires. Stays
    // null for a plain text/system/gif-without-attachment send.
    let resolvedAttachment:
      GifAttachment | DocumentAttachment | StickerAttachment | null = null;
    if (kind === 'gif' && attachment) {
      if (!/^https:\/\//.test(attachment.url)) {
        throw new BadRequestException('A gif attachment must be an https URL');
      }
      if (
        typeof attachment.previewUrl !== 'string' ||
        typeof attachment.width !== 'number' ||
        typeof attachment.height !== 'number'
      ) {
        throw new BadRequestException('Invalid gif attachment');
      }
      resolvedAttachment = {
        url: attachment.url,
        previewUrl: attachment.previewUrl,
        width: attachment.width,
        height: attachment.height,
        provider: attachment.provider,
        caption: this.sanitizeAttachmentCaption(attachment.caption),
      };
    }
    if (kind === 'image' && attachment) {
      if (
        typeof attachment.previewUrl !== 'string' ||
        typeof attachment.width !== 'number' ||
        typeof attachment.height !== 'number'
      ) {
        throw new BadRequestException('Invalid image attachment');
      }
      // A forwarded image's `url`/`previewUrl` arrive as the ALREADY-RESOLVED
      // `GET /files/<key>` URL (the forwarded ChatMessage's attachment came
      // from a server response, which resolves keys at read time — see
      // `resolveAttachment`), not the bare key a fresh upload sends. Collapse
      // either shape back to the canonical bare key before validating or
      // persisting — the storage layer stores keys, never URLs (mirrors every
      // other image field via `storageKeyFromImageUrl`), and this is also what
      // makes the ownership check below correct for a forward, not just a
      // fresh send.
      //
      // Final fix F1 (C1): a forward of an image a business, persona or
      // company sent arrives as its message reference, and resolves to a key
      // through `resolveForwardedAttachmentReference`, `previewUrl` included.
      const forwardedAttachmentKey =
        await this.resolveForwardedAttachmentReference(
          attachment.url,
          senderId,
          MessageKind.Image,
          shouldClaimOnReply,
        );
      const url =
        forwardedAttachmentKey ?? storageKeyFromImageUrl(attachment.url);
      const previewUrl =
        forwardedAttachmentKey ?? storageKeyFromImageUrl(attachment.previewUrl);
      // The attachment's `url` must be a well-formed `message-image` storage
      // key — otherwise any authenticated member could attach an arbitrary
      // key (an unrelated kind's, or a malformed string) to a message. 404-
      // style rejection posture doesn't apply here (unlike `FilesController`,
      // nothing is disclosed either way) — a plain 400 is correct.
      if (parseStorageKey(url) !== UPLOAD_KIND_SPECS['message-image']) {
        throw new BadRequestException('Invalid image attachment');
      }
      // The attachment must be one this sender is entitled to send. Two
      // legitimate cases:
      //   1. A FRESH send of the sender's OWN upload — the key encodes the
      //      uploader, so `storageKeyOwnerId(key) === senderId` proves it.
      //   2. A genuine FORWARD of an image the sender already had access to —
      //      an existing image message carrying this exact attachment key lives
      //      in a conversation the sender is (or once was) a participant of.
      //
      // The client's `forwarded` boolean is a DISPLAY HINT only and is never
      // trusted to skip this check: a forward is DERIVED server-side from a
      // message the sender provably had access to (see
      // `senderCanForwardAttachment`). Before this, `forwarded: true` alone
      // bypassed the ownership check, so any member who merely knew someone
      // else's `message-image` key could attach it by asserting the flag — the
      // flag is now non-authoritative and the server proves genuine access.
      if (storageKeyOwnerId(url) !== senderId) {
        const isGenuineForward = await this.senderCanForwardAttachment(
          senderId,
          url,
          MessageKind.Image,
        );
        if (!isGenuineForward) {
          throw new ForbiddenException(
            'You may only attach an image you uploaded',
          );
        }
      }
      resolvedAttachment = {
        url,
        previewUrl,
        width: attachment.width,
        height: attachment.height,
        provider: attachment.provider,
        caption: this.sanitizeAttachmentCaption(attachment.caption),
      };
    }
    if (kind === 'document' && attachment) {
      if (
        typeof attachment.fileName !== 'string' ||
        typeof attachment.byteSize !== 'number' ||
        typeof attachment.contentType !== 'string'
      ) {
        throw new BadRequestException('Invalid document attachment');
      }
      // Same URL-normalisation as the `image` branch above: a forward's
      // attachment arrives already resolved to `GET /files/<key>` (see
      // `resolveAttachment`), never a bare key. `storageKeyFromImageUrl` is
      // format-agnostic (it only strips the app's own `/files/` prefix), so it
      // applies unchanged to a document key. Final fix F1 (C1): a forwarded
      // message reference resolves as on the image branch.
      const forwardedAttachmentKey =
        await this.resolveForwardedAttachmentReference(
          attachment.url,
          senderId,
          MessageKind.Document,
          shouldClaimOnReply,
        );
      const url =
        forwardedAttachmentKey ?? storageKeyFromImageUrl(attachment.url);
      // The attachment's `url` must be a well-formed `message-document`
      // storage key — same reasoning as the image branch's own check.
      if (parseStorageKey(url) !== UPLOAD_KIND_SPECS['message-document']) {
        throw new BadRequestException('Invalid document attachment');
      }
      // Same two-case ownership rule as an image: the sender's own fresh
      // upload (key embeds their id), or a genuine forward of a document they
      // provably had access to. Never trusts the client's `forwarded` flag —
      // see the identical reasoning on the image branch above.
      if (storageKeyOwnerId(url) !== senderId) {
        const isGenuineForward = await this.senderCanForwardAttachment(
          senderId,
          url,
          MessageKind.Document,
        );
        if (!isGenuineForward) {
          throw new ForbiddenException(
            'You may only attach a document you uploaded',
          );
        }
      }
      // Defence in depth beyond the presign-time cap: a forged attachment
      // payload could claim a `byteSize`/`contentType` the presign step never
      // actually enforced against THIS object. Re-assert both server-side
      // rather than trusting whatever the client echoes back.
      if (
        attachment.byteSize > UPLOAD_KIND_SPECS['message-document'].maxBytes
      ) {
        throw new BadRequestException(
          'Document attachment exceeds the size limit',
        );
      }
      if (!(attachment.contentType in DOCUMENT_UPLOAD_TYPES)) {
        throw new BadRequestException('Unsupported document content type');
      }
      resolvedAttachment = {
        url,
        // `fileName` is member-supplied, display-only text (never used to
        // build the storage key or a served header — see `DocumentAttachment`'s
        // own doc) but it IS rendered verbatim in the bubble, so bound its
        // length and strip control/newline characters before persisting.
        fileName: this.sanitizeDisplayFileName(attachment.fileName),
        byteSize: attachment.byteSize,
        contentType: attachment.contentType,
        provider: attachment.provider,
        caption: this.sanitizeAttachmentCaption(attachment.caption),
      };
    }
    if (kind === 'sticker') {
      // A sticker carries no member-authored text. The frontend sends its
      // localized "Sticker" fallback as `body` so the existing `@MinLength(1)`
      // still holds; it is dropped below before storage, so a sticker
      // message is always a bare picture bubble with no attached text.
      if (attachment) {
        throw new BadRequestException(
          'A sticker send requires a stickerId and carries no attachment',
        );
      }
      if (!stickerId) {
        throw new BadRequestException('Missing stickerId');
      }
      const sticker = await this.stickers.findOne({
        where: { id: stickerId },
        relations: { pack: true },
      });
      // An unknown sticker and one in an unpublished pack are the same 400:
      // nothing here is worth disclosing, and a draft pack must not be
      // sendable from a client that guessed an id.
      if (!sticker || sticker.pack?.status !== StickerPackStatus.Published) {
        throw new BadRequestException('Unknown or unavailable sticker');
      }
      body = '';
      resolvedAttachment = {
        url: sticker.storageKey,
        previewUrl: sticker.storageKey,
        width: sticker.width,
        height: sticker.height,
        provider: 'sticker',
        stickerId: sticker.id,
        label: sticker.label,
      };
    }
    const entityKind =
      kind === 'gif'
        ? MessageKind.Gif
        : kind === 'image'
          ? MessageKind.Image
          : kind === 'document'
            ? MessageKind.Document
            : kind === 'sticker'
              ? MessageKind.Sticker
              : MessageKind.User;
    // DTO callers arrive already sanitized; server-composed bodies (enquiries,
    // a materialized connection note) get the same pass here. A sticker send's
    // `body` was already dropped to '' above, so it stores no text.
    const storedBody = sanitizeMessageBody(body);
    if (!storedBody && !resolvedAttachment) {
      throw new BadRequestException('body must not be empty');
    }
    let saved: Message;
    let implicitClaimedAt: Date | null;
    try {
      const persisted = await this.persistSentMessage(
        this.messages.create({
          conversationId,
          senderId,
          senderIdentityId,
          body: storedBody,
          replyToId: replyToId ?? null,
          clientMessageId: clientMessageId ?? null,
          forwarded: forwarded ?? false,
          kind: entityKind,
          // `resolvedAttachment` is only ever set inside a gif/image/document
          // branch above (and only once every kind-specific field has been
          // validated) — never persist a raw, unvalidated `attachment` here.
          attachment: resolvedAttachment,
        }),
        shouldClaimOnReply ? { conversationId, senderId } : null,
      );
      saved = persisted.message;
      implicitClaimedAt = persisted.implicitClaimedAt;
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
          this.assertOwnIdempotencyKey(winner, senderId);
          return this.buildPostResult(winner, senderId, false);
        }
      }
      throw error;
    }
    // Task 23: the claim event goes out after the transaction has committed
    // and BEFORE `buildPostResult` emits MESSAGE_CREATED, so the push
    // listener, which narrows staff push to the claimant, reads the claim
    // this reply just committed.
    if (implicitClaimedAt) {
      this.emitImplicitClaim({
        conversationId,
        mailboxIdentityId: senderIdentityId,
        change: 'claimed',
        isImplicit: true,
        actorUserId: senderId,
        claimedByUserId: senderId,
        previousClaimantUserId: null,
        changedAt: implicitClaimedAt,
      });
    }
    return this.buildPostResult(saved, senderId, true);
  }

  /**
   * Final fix F1 (C3): whether `senderId` is the house account posting into
   * the official thread `conversationId`. Both must hold: the thread is
   * official, and the sender is a system account (`users.is_system`, which
   * only the house account carries). A member replying in their own official
   * thread holds a seat and never reaches this.
   */
  private async isHouseAccountOfficialSend(
    conversationId: string,
    senderId: string,
  ): Promise<boolean> {
    const [isOfficial, sender] = await Promise.all([
      this.isOfficialConversation(conversationId),
      this.usersService.findById(senderId),
    ]);
    return isOfficial && sender?.isSystem === true;
  }

  /**
   * Final fix F1 (C1): the storage key a forwarded attachment reference
   * stands for, or `null` when `value` is no reference (a fresh upload or a
   * forward of a personal message, both of which keep their key path).
   *
   * The sender must be able to see the referenced message by the same rules
   * its download applies (`viewableMessageAttachmentQuery`), and it must be of
   * the kind being sent; otherwise the forward is refused as the key path
   * refuses one. A forward sent AS a business, persona or company
   * (`isSentAsMailboxIdentity`) keeps the original key, since its own reads
   * render the new message by reference too. A forward sent as the member
   * themself gets a copy under the member's own key, unless the key is
   * already theirs, so the personal message never carries another person's
   * user id.
   */
  private async resolveForwardedAttachmentReference(
    value: string,
    senderId: string,
    attachmentKind: MessageKind.Image | MessageKind.Document,
    isSentAsMailboxIdentity: boolean,
  ): Promise<string | null> {
    const reference = messageAttachmentReferenceFromImageUrl(value);
    const parsedReference = reference
      ? parseMessageAttachmentReference(reference)
      : null;
    if (!parsedReference) {
      return null;
    }
    const source = await viewableMessageAttachmentQuery(
      this.messages,
      parsedReference.messageId,
      senderId,
    )
      .andWhere('message.kind = :forwardedKind', {
        forwardedKind: attachmentKind,
      })
      .getOne();
    const sourceKey = source ? messageAttachmentRouteStorageKey(source) : null;
    if (!sourceKey) {
      throw new ForbiddenException(
        attachmentKind === MessageKind.Image
          ? 'You may only attach an image you uploaded'
          : 'You may only attach a document you uploaded',
      );
    }
    if (isSentAsMailboxIdentity || storageKeyOwnerId(sourceKey) === senderId) {
      return sourceKey;
    }
    // Controller ruling after fix round N1: the uploader's account status is
    // not read here. Every source this path accepts was sent as a business,
    // persona or company (`viewableMessageAttachmentQuery`), whose bytes the
    // reference route serves to this same member whatever the uploader's
    // status, so refusing the copy would protect nothing and would tell the
    // member that some staff member is suspended. A personal source never
    // reaches this line: the query refuses it, and a key-based forward of it
    // keeps the uploader's key, which the key route goes on withholding.
    // A suspended forwarder is refused by the send path before this runs.
    if (!this.storage) {
      throw new InternalServerErrorException('Service temporarily unavailable');
    }
    return this.storage.copyObjectToOwner(sourceKey, senderId);
  }

  /**
   * Task 23: whether `identityId` is a business, persona or company
   * identity. One batched identity read per send, made only for a send
   * with a chosen identity.
   */
  private async isMailboxIdentity(identityId: string): Promise<boolean> {
    const [identity] = await this.identities.getByIds([identityId]);
    return identity !== undefined && identity.kind !== IdentityKind.Profile;
  }

  /**
   * Task 23: saves a fresh message. With a `claimant` (a reply sent as a
   * business identity), the insert and the claim run in ONE transaction:
   * `claimUnclaimedConversation`, the same write `ConversationsService.claim`
   * makes, claims the thread for the sender only while nobody holds it, so a
   * reply never moves a colleague's claim. An insert that fails rolls the
   * claim back with it, and the caller's `23505` branch then returns the
   * winner as before. `implicitClaimedAt` is the database's claim time when the
   * UPDATE matched a row, and null otherwise.
   */
  private async persistSentMessage(
    draft: Message,
    claimant: { conversationId: string; senderId: string } | null,
  ): Promise<{ message: Message; implicitClaimedAt: Date | null }> {
    if (!claimant) {
      return {
        message: await this.messages.save(draft),
        implicitClaimedAt: null,
      };
    }
    return this.dataSource.transaction(async (manager) => {
      const message = await manager.getRepository(Message).save(draft);
      const implicitClaimedAt = await claimUnclaimedConversation(
        manager.getRepository(Conversation),
        claimant.conversationId,
        claimant.senderId,
      );
      return { message, implicitClaimedAt };
    });
  }

  /**
   * Task 23: announces a claim a reply took, exactly as a manual claim is
   * announced (`CONVERSATION_CLAIM_CHANGED`, relayed to staff seats by
   * `MailboxStaffRelayListener`). Best-effort: the reply has committed, so
   * a relay failure is logged and the send still succeeds.
   */
  private emitImplicitClaim(event: ConversationClaimChangedEvent): void {
    try {
      this.eventEmitter.emit(CONVERSATION_CLAIM_CHANGED, event);
    } catch (error) {
      implicitClaimRelayLogger.error(
        `Failed to relay the claim a reply took on conversation ${
          event.conversationId
        }: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Idempotency is a contract between ONE sender and their own retry, so a
   * dedup hit belonging to somebody else is refused rather than returned.
   *
   * The dedup key `(conversation_id, client_message_id)` carries no sender (and
   * neither does the partial unique index behind it), so without this a
   * participant who reused another participant's `clientMessageId` — which is
   * echoed to everyone in every `MessageResponse` and in the `message:new`
   * broadcast — got that member's message handed back as though it were their
   * own successful send: no insert, no error, and `reactions.mine` computed for
   * the wrong person. A 409 is the honest answer; a genuine `randomUUID()`
   * collision between two members in one conversation is not a real event.
   */
  private assertOwnIdempotencyKey(existing: Message, senderId: string): void {
    if (existing.senderId !== senderId) {
      throw new ConflictException(
        'That clientMessageId is already in use in this conversation',
      );
    }
  }

  /**
   * True when `senderId` is entitled to FORWARD the attachment stored at
   * `attachmentKey`: an existing message of `attachmentKind` (`Image` or
   * `Document`) carrying that exact attachment key lives in a conversation the
   * sender is (or once was) a participant of. That proves the sender genuinely
   * had access to the attachment, so a forward can safely skip the "must be
   * your own upload" ownership check WITHOUT trusting any client-supplied flag
   * or id — closing the client-controlled `forwarded` bypass.
   * `attachmentKey` is the canonical bare storage key (callers collapse the
   * resolved `/files/<key>` URL back to the key before this runs). A member
   * who left a group (`leftAt`) still qualifies: they retain read access to
   * history, so they genuinely saw the attachment and may forward it.
   *
   * Task 13g: two seats no longer qualify, since a forward re-serves the
   * bytes to everyone in the destination thread (`FilesController`). A staff
   * seat excluded by the block rule, so a staff member a customer blocked
   * cannot pass that customer's photos and documents on. And a departed
   * staff seat, one that speaks for a business identity and has `leftAt`
   * set, so a member who no longer works for the business cannot pass its
   * customers' files on either. Task 14a: both rules are read from
   * `staffSeatExcludedFromMailboxPredicate`, their one home. A seat that
   * speaks for the member themself keeps the group leaver's allowance above.
   * Task 14: read through `seatExcludedFromMailboxPredicate`, so a customer
   * who blocked the business cannot forward from that thread either.
   */
  private async senderCanForwardAttachment(
    senderId: string,
    attachmentKey: string,
    attachmentKind: MessageKind.Image | MessageKind.Document,
  ): Promise<boolean> {
    const accessibleCount = await this.messages
      .createQueryBuilder('message')
      .innerJoin(
        ConversationParticipant,
        'participant',
        'participant.conversation_id = message.conversation_id AND participant.user_id = :senderId',
        { senderId },
      )
      .where('message.kind = :attachmentKind', { attachmentKind })
      .andWhere("message.attachment ->> 'url' = :attachmentKey", {
        attachmentKey,
      })
      .andWhere(
        `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':senderId')}`,
      )
      // Task 13h: a message at or before the history floor of the sender's
      // mailbox staff seat in its thread is one they cannot see, so it
      // proves no access. Forwarding it would hand a co-manager the owner's
      // and the customer's pre-floor files. A personal or group seat's
      // "clear chat" keeps its earlier allowance.
      .andWhere(
        `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`,
      )
      .getCount();
    return accessibleCount > 0;
  }

  // The longest a document's displayed file name may be — generous for any
  // real file name, tight enough that a pathological value can't bloat every
  // response that echoes it back.
  private static readonly MAX_DISPLAY_FILE_NAME_LENGTH = 200;

  /**
   * Bounds and cleans a document attachment's member-supplied `fileName`
   * before it is ever persisted. This value is DISPLAY-ONLY (see
   * `DocumentAttachment`'s own doc for why it can never become a header- or
   * path-injection vector regardless), but it IS rendered verbatim as text in
   * the message bubble, so control characters and newlines — which could
   * otherwise make a bubble render oddly or carry an invisible payload — are
   * stripped, and the length is capped. Falls back to a generic placeholder
   * only when nothing displayable survives (an empty or all-control-character
   * name), never silently drops the attachment itself.
   */
  private sanitizeDisplayFileName(fileName: string): string {
    // eslint-disable-next-line no-control-regex -- deliberately matching C0/DEL control bytes to strip them.
    const withoutControlCharacters = fileName.replace(/[\x00-\x1f\x7f]/g, '');
    const trimmed = withoutControlCharacters.trim();
    const bounded = trimmed.slice(
      0,
      MessagingCoreService.MAX_DISPLAY_FILE_NAME_LENGTH,
    );
    return bounded.length > 0 ? bounded : 'Document';
  }

  // The longest a caption may be — generous for a genuine WhatsApp-style
  // caption, tight enough that a pathological value can't bloat every
  // response/broadcast that echoes it back. The DTO already enforces this at
  // the transport boundary (`GifAttachmentDto.caption`'s own `@MaxLength`);
  // repeated here because this method also runs against `AttachmentInput`
  // wire values that bypass the DTO's own validation in unit tests.
  private static readonly MAX_ATTACHMENT_CAPTION_LENGTH = 1000;

  /**
   * Bounds and cleans a `kind:'gif'`/`kind:'image'`/`kind:'document'` send's
   * optional, member-supplied caption before it is ever persisted — the same
   * write-boundary treatment `sanitizeDisplayFileName` above gives a
   * document's `fileName`, plus markup-stripping, since a caption is the ONE
   * new piece of freeform text this slice introduces (a file name is already
   * bounded to a handful of realistic characters; a caption is prose a member
   * actually composes, so it needs the same defence every other freeform
   * member text field gets before being rendered verbatim in a bubble).
   *
   * UNLIKE `sanitizeDisplayFileName`, this does NOT strip `\n`: a caption is
   * typed in the composer's own textarea, the identical multi-line control an
   * ordinary message `body` uses (`TrimMessageBody` only trims the OUTER
   * whitespace of a body and never touches an internal line break), so a
   * caption and a body must not disagree about what counts as legal text —
   * stripping every newline here would silently run a two-line caption's words
   * together. CRLF and a lone CR are first normalized to `\n` (a pasted
   * Windows-style caption must not end up with a stray, invisible `\r` sitting
   * next to the `\n` a fresh Linux/macOS-typed one gets), and every OTHER
   * C0/DEL control byte is still stripped, same as `sanitizeDisplayFileName`.
   * Markup is stripped next through `toStoredPlainText` — the same
   * write-boundary plain-text pass `community-plain-text.ts` uses for every
   * other short, non-rich-text member field — so a crafted `<img
   * onerror=...>` or `&lt;script&gt;` never survives into the bubble even
   * though a caption was never HTML to begin with; `sanitizeHtml` with an
   * empty tag allowlist passes an input's newlines through unchanged (verified
   * directly — it neither collapses nor drops them), so this step cannot
   * undo the normalization above. `undefined` in (no caption typed) stays
   * `undefined` out; a caption that sanitizes down to nothing (all
   * whitespace, all markup) is also dropped rather than persisted as an empty
   * string — unlike a document's `fileName`, a caption is OPTIONAL, so there
   * is no placeholder to fall back to and none is needed.
   */
  private sanitizeAttachmentCaption(
    caption: string | undefined,
  ): string | undefined {
    if (caption === undefined) {
      return undefined;
    }
    const withNormalizedLineBreaks = caption
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const withoutControlCharacters = withNormalizedLineBreaks.replace(
      // eslint-disable-next-line no-control-regex -- deliberately matching every C0/DEL control byte EXCEPT \n (\x0a), which the normalization above already made the sole line-break form, to strip them.
      /[\x00-\x09\x0b-\x1f\x7f]/g,
      '',
    );
    const withoutMarkup = toStoredPlainText(withoutControlCharacters);
    const bounded = withoutMarkup.slice(
      0,
      MessagingCoreService.MAX_ATTACHMENT_CAPTION_LENGTH,
    );
    return bounded.length > 0 ? bounded : undefined;
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
  ): Promise<{ view: MessageView; response: MessageResponse; isNew: boolean }> {
    const view = toMessageView(message);
    // `hasViewerLeftConversation` is deliberately omitted (defaults to
    // `false`): every caller of `buildPostResult` reaches it only after
    // proving `senderId` may currently write here (`sendMessage`'s own
    // `leftAt`/block checks, or a message-request flow seeding a brand-new
    // participant row), so `senderId` is always active at this point.
    const [response] = await this.toMessageResponses([message], senderId);
    // invariant: toMessageResponses returns one response per input row.
    if (emit) {
      // Unarchive for EVERY participant (sender included) the instant a
      // genuinely new message lands. "Archived" means "nothing new here" —
      // the moment something new happens, that stops being true, mirroring
      // this same conversation's own `clearedAt` "delete for me" semantics
      // (a newer message already resurrects a cleared thread) and the
      // WhatsApp/Gmail default: an archive is never the reason a reply goes
      // unseen. A no-op UPDATE (the common case: nobody had archived it) is
      // cheap — one indexed match on `conversation_id`, filtered to rows that
      // actually need clearing.
      await this.participants
        .createQueryBuilder()
        .update(ConversationParticipant)
        .set({ archivedAt: null })
        .where('conversation_id = :conversationId', {
          conversationId: message.conversationId,
        })
        .andWhere('archived_at IS NOT NULL')
        .execute();
      this.eventEmitter.emit(MESSAGE_CREATED, {
        conversationId: message.conversationId,
        message: view,
        response: response!,
      } satisfies MessageCreatedEvent);
    }
    // `emit` is true only for a genuinely fresh insert (never for an
    // idempotency-key dedup hit or a race loser fetched back), so it doubles
    // as the "is this a first-time send" signal callers need to gate
    // side effects that must not repeat on a retried/duplicated send — e.g.
    // `MessagesService.sendMessage`'s `@`-mention notification fan-out.
    return { view, response: response!, isNew: emit };
  }

  /**
   * The canonical key for a one-to-one thread, sorted so argument order cannot
   * create a duplicate. It keys on IDENTITIES, which is what lets a member
   * hold both a personal thread with a shop's owner and a separate thread with
   * the shop without colliding on the unique index.
   */
  identityPairKey(identityIdA: string, identityIdB: string): string {
    if (identityIdA === identityIdB) {
      throw new Error('A conversation needs two different identities');
    }
    return [identityIdA, identityIdB].sort().join(':');
  }

  /**
   * The `identityPairKey` for two members each acting as themselves, resolving
   * both to their own profile identity first. For a caller that only ever
   * looks up or opens a PERSONAL thread and never one where either side is
   * acting as a business identity (`ConversationsService.createConversation`'s
   * pre-connection existing-thread check is the one caller today).
   */
  async resolveProfilePairKey(
    userIdA: string,
    userIdB: string,
  ): Promise<string> {
    const [identityIdA, identityIdB] = await Promise.all([
      this.identities.resolveProfileIdentityId(userIdA),
      this.identities.resolveProfileIdentityId(userIdB),
    ]);
    return this.identityPairKey(identityIdA, identityIdB);
  }

  /**
   * PRD-340: `coldContactInitiatorUserId` is an explicit opt-in that only
   * `MessageRequestsService.deliverEnquiry` (a cold, deliberately
   * connection-bypassing delivery) passes, as the enquirer's own id.
   * Every other caller (an already-connected `messageRequest`, `handleConnectionAccepted`,
   * `ConversationsService.createConversation`) omits it, because those pairs
   * are already connected and the gate never applies to them. Recording an
   * initiator for a CONNECTED pair would wrongly let the reply gate re-open
   * their thread with one tap if they ever disconnect, inferring "opened"
   * from ordinary message history, which the brief explicitly forbids.
   *
   * On a FRESH conversation, `coldContactInitiatorUserId` (if given) seeds
   * `initiatorUserId`. On an EXISTING one, it claims the initiator ONLY when
   * the thread has none yet AND isn't already open. A fresh enquiry into an
   * old, never-replied-to thread IS itself fresh cold contact, so it earns
   * the same one-tap-reply treatment a brand new enquiry would. It never
   * touches a thread that already has an initiator (its story is already
   * told) or is already open (nothing to claim).
   *
   * `identityIdB` is who `userIdB` is being reached AS: a listing or company
   * mailbox rather than their own profile. It defaults to `userIdB`'s own
   * profile identity, which is every call site today (Tasks 7/8 pass a real
   * mailbox identity). `userIdA` always acts as their own profile identity
   * here; a caller sending AS a business identity goes through the identity
   * send path instead.
   */
  async getOrCreateConversation(
    userIdA: string,
    userIdB: string,
    coldContactInitiatorUserId?: string,
    identityIdB?: string,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const identityIdA = await this.identities.resolveProfileIdentityId(userIdA);
    const resolvedIdentityIdB =
      identityIdB ?? (await this.identities.resolveProfileIdentityId(userIdB));
    const pairKey = this.identityPairKey(identityIdA, resolvedIdentityIdB);
    const existing = await this.conversations.findOne({ where: { pairKey } });
    if (existing) {
      if (
        coldContactInitiatorUserId &&
        !existing.initiatorUserId &&
        !existing.openedAt
      ) {
        await this.conversations.update(existing.id, {
          initiatorUserId: coldContactInitiatorUserId,
        });
        existing.initiatorUserId = coldContactInitiatorUserId;
      }
      return { conversation: existing, created: false };
    }
    // Reply-only: only a member acting as themselves may open a fresh
    // thread. This check sits right before creation; the reuse branch
    // above hands back an already-open thread, so it needs no guard here.
    await this.assertInitiatorIsProfile(identityIdA);
    try {
      const conversation = await this.dataSource.transaction(
        async (manager) => {
          const convo = await manager.save(
            manager.create(Conversation, {
              isOfficial: false,
              pairKey,
              initiatorUserId: coldContactInitiatorUserId ?? null,
            }),
          );
          await manager.save([
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: userIdA,
              identityId: identityIdA,
            }),
            manager.create(ConversationParticipant, {
              conversationId: convo.id,
              userId: userIdB,
              identityId: resolvedIdentityIdB,
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

  /**
   * Task 18: whether `fromUserId` may write to the mailbox `toIdentityId`,
   * as a refusal code or null, with the mailbox's current staff. The one
   * answer both the read-only contactability hint and the write
   * (`getOrCreateIdentityConversation`) use, so the two cannot disagree.
   *
   * A person block between the member and one staff member is deliberately
   * absent here. Refusing on it would tell the member that person works for
   * the business; the thread seats every staff member and the read-time
   * rules (`isSeatExcludedFromMailbox` and its SQL twin) leave the blocked
   * one out. The member's block of the identity itself is a
   * `BlockFilterService` question, answered by `MessageRequestsService`.
   */
  async evaluateIdentityContact(
    fromUserId: string,
    toIdentityId: string,
  ): Promise<{
    refusal: IdentityContactRefusal | null;
    staffUserIds: string[];
  }> {
    const identity = await this.identities.getById(toIdentityId);
    if (!identity || identity.kind === IdentityKind.Profile) {
      return { refusal: 'IDENTITY_NOT_A_MAILBOX', staffUserIds: [] };
    }
    if (await this.identities.isRemovedPersona(identity)) {
      return { refusal: 'IDENTITY_REMOVED', staffUserIds: [] };
    }
    const staffUserIds = await this.identities.staffUserIds(toIdentityId);
    if (staffUserIds.length === 0) {
      return { refusal: 'IDENTITY_HAS_NO_STAFF', staffUserIds };
    }
    if (staffUserIds.includes(fromUserId)) {
      return { refusal: 'IDENTITY_IS_YOUR_OWN', staffUserIds };
    }
    return { refusal: null, staffUserIds };
  }

  /**
   * Task 18: the thread `fromUserId`, as themselves, already has with the
   * mailbox `toIdentityId`, or null. Read-only; keyed exactly as
   * `getOrCreateIdentityConversation` keys the thread it opens.
   */
  async findIdentityConversation(
    fromUserId: string,
    toIdentityId: string,
  ): Promise<Conversation | null> {
    const fromIdentityId =
      await this.identities.resolveProfileIdentityId(fromUserId);
    if (fromIdentityId === toIdentityId) {
      return null;
    }
    return this.conversations.findOne({
      where: { pairKey: this.identityPairKey(fromIdentityId, toIdentityId) },
    });
  }

  /**
   * Task 18: open or reuse the thread between a member and a mailbox
   * identity (a listing, persona or company). The business side is one seat
   * per staff member, each stamped with the mailbox identity, which keeps
   * unread, mute, pin and drafts per person while the thread belongs to the
   * mailbox. The thread is keyed on the identity pair, so the member's
   * personal thread with the owner stays a separate conversation.
   *
   * `fromIdentityId` is the identity the member is acting as, when the
   * request names one (the mailbox switcher sends it on every write). It must
   * be one they may act as, and the reply-only rule
   * (`assertInitiatorIsProfile`) then refuses anything but their own profile,
   * on a reuse as much as on a creation.
   *
   * Refusals, each coded (`evaluateIdentityContact`): the target is no
   * mailbox, a removed persona, a mailbox with no staff (nobody could ever
   * answer), or one the member staffs.
   *
   * `coldContactInitiatorUserId` works exactly as it does in
   * `getOrCreateConversation`: it seeds `initiatorUserId` on a new thread,
   * and claims an existing thread that has no initiator and is not open yet.
   * A reused thread is returned as it is. Seating the current staff on it is
   * the caller's step (`IdentityMailboxSyncService.resyncMailbox`), and the
   * member's own seat is left untouched, as a reused personal thread is.
   */
  async getOrCreateIdentityConversation(
    fromUserId: string,
    toIdentityId: string,
    coldContactInitiatorUserId?: string,
    fromIdentityId?: string,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    if (fromIdentityId) {
      await this.identities.assertMayActAs(fromUserId, fromIdentityId);
    }
    const senderIdentityId =
      fromIdentityId ??
      (await this.identities.resolveProfileIdentityId(fromUserId));
    await this.assertInitiatorIsProfile(senderIdentityId);
    const { refusal, staffUserIds } = await this.evaluateIdentityContact(
      fromUserId,
      toIdentityId,
    );
    if (refusal) {
      throw identityContactRefusalException(refusal);
    }

    const pairKey = this.identityPairKey(senderIdentityId, toIdentityId);
    const existing = await this.conversations.findOne({ where: { pairKey } });
    if (existing) {
      if (
        coldContactInitiatorUserId &&
        !existing.initiatorUserId &&
        !existing.openedAt
      ) {
        await this.conversations.update(existing.id, {
          initiatorUserId: coldContactInitiatorUserId,
        });
        existing.initiatorUserId = coldContactInitiatorUserId;
      }
      return { conversation: existing, created: false };
    }
    try {
      const conversation = await this.dataSource.transaction(
        async (manager) => {
          const created = await manager.save(
            manager.create(Conversation, {
              isOfficial: false,
              pairKey,
              initiatorUserId: coldContactInitiatorUserId ?? null,
            }),
          );
          await manager.save([
            manager.create(ConversationParticipant, {
              conversationId: created.id,
              userId: fromUserId,
              identityId: senderIdentityId,
            }),
            ...staffUserIds.map((staffUserId) =>
              manager.create(ConversationParticipant, {
                conversationId: created.id,
                userId: staffUserId,
                identityId: toIdentityId,
              }),
            ),
          ]);
          return created;
        },
      );
      return { conversation, created: true };
    } catch (error) {
      // Lost a concurrent create race on the UNIQUE pair_key: return the
      // winner, as `getOrCreateConversation` does.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === '23505'
      ) {
        const winner = await this.conversations.findOne({
          where: { pairKey },
        });
        if (winner) {
          return { conversation: winner, created: false };
        }
      }
      throw error;
    }
  }
}

/**
 * Task 18: why a member may not write to a mailbox identity. Each is the
 * stable `code` of the refusal `identityContactRefusalException` builds.
 */
export type IdentityContactRefusal =
  | 'IDENTITY_NOT_A_MAILBOX'
  | 'IDENTITY_REMOVED'
  | 'IDENTITY_HAS_NO_STAFF'
  | 'IDENTITY_IS_YOUR_OWN';

/** Task 18: the coded HTTP refusal for one `IdentityContactRefusal`. */
export function identityContactRefusalException(
  refusal: IdentityContactRefusal,
): BadRequestException | ForbiddenException {
  switch (refusal) {
    case 'IDENTITY_NOT_A_MAILBOX':
      return new BadRequestException({
        code: refusal,
        message: 'There is no mailbox to write to here',
      });
    case 'IDENTITY_REMOVED':
      return new ForbiddenException({
        code: refusal,
        message: 'This persona was removed and cannot be messaged',
      });
    case 'IDENTITY_HAS_NO_STAFF':
      return new BadRequestException({
        code: refusal,
        message: 'Nobody can answer for this yet',
      });
    case 'IDENTITY_IS_YOUR_OWN':
      return new BadRequestException({
        code: refusal,
        message: 'You cannot message a mailbox you answer',
      });
  }
}
