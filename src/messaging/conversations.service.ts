import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { decodeCursor, encodeCursor } from '../common/cursor-pagination';
import { toImageUrl } from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { cropFor } from '../media-crops/crop-response';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  MEMBER_BLOCKED,
  MEMBER_UNBLOCKED,
  MemberBlockedEvent,
  MemberUnblockedEvent,
} from '../social/social.events';
import { Profile } from '../users/entities/profile.entity';
import { PreferencesService } from '../preferences/preferences.service';
import {
  ConversationMuteMode,
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { loadSenderIdentityContext } from './author-summary';
import { movedNoteMailboxIdentityIds } from './viewer-message-fields';
import {
  claimUnclaimedConversation,
  ClaimResponse,
  CONVERSATION_CLAIM_CHANGED,
  ConversationClaimChangedEvent,
  ConversationListPageWithStaffClaim,
  ConversationResponseWithStaffClaim,
  NO_STAFF_CLAIM_FIELDS,
  ReleaseClaimResponse,
  returnedTimestamp,
  staffClaimFields,
  TakeOverClaimResponse,
} from './conversation-claim';
import {
  DirectThreadSeats,
  describeDirectThreadSeats,
  isSeatExcludedFromMailbox,
  loadMailboxIdentityBlockKeys,
  mailboxIdentityBlockCandidates,
  mailboxThreadPredicate,
  NOT_A_DIRECT_THREAD,
  renderDirectCounterpart,
  seatExcludedFromMailboxPredicate,
} from './mailbox-seats';
import {
  AuthorSummary,
  computeGroupLeftReason,
  ConversationResponse,
  presentSenderIds,
  toAuthorSummary,
} from './message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import { DEFAULT_LIMIT, MAX_LIMIT } from './messaging.constants';
import { MessagingCoreService } from './messaging-core.service';
import {
  MESSAGE_DELIVERED,
  MESSAGE_READ,
  MessageDeliveredEvent,
  MessageReadEvent,
} from './messaging.events';

/**
 * PRD-343: the discriminator on `createConversation`'s 403 body for "these two
 * are not accepted connections and no thread between them is already open",
 * a code rather than the message text, so the frontend
 * (`useThreadCreation.ts`) never has to match on prose that a reword or
 * localization would break. Mirrors `COMMUNITY_MEMBERS_ONLY_CODE`
 * (`communities/community-gate.ts`).
 */
export const CONVERSATION_REQUIRES_CONNECTION_CODE =
  'CONVERSATION_REQUIRES_CONNECTION';

/**
 * Task 19: logs a claim-change relay that threw. Module-level so it exists
 * however the service was constructed.
 */
const claimRelayLogger = new Logger('ConversationsService');

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
    // ENG-248: transactional cap-check-plus-write lock in `setPinned`, the
    // same `dataSource.transaction` + row-lock idiom `VouchService`/
    // `ListingCoManagersService` use for their own per-member caps.
    private readonly dataSource: DataSource,
    // Batched crop lookup (`MediaCropService.getMany`) for a group's
    // `avatarUrl` sibling `avatarCrop`.
    private readonly mediaCropService: MediaCropService,
    // `replyRequiresConnection` (PRD-220): whether the caller and a DM's
    // counterpart are accepted connections.
    private readonly connectionsService: ConnectionsService,
    // PRD-364: reciprocal read-receipt sharing — gates `markRead`'s
    // `MESSAGE_READ` emit and the `otherLastReadAt`/group-member read-state
    // fields this service serialises.
    private readonly preferencesService: PreferencesService,
    // Business mailboxes (Tasks 7-9): `assertMayActAs` gates `claim`/`release`
    // to a human who actually staffs the mailbox this thread belongs to.
    private readonly identities: IdentitiesService,
    // Fix round 1 (Task 11): resolves the staff first name (if any) a
    // business sender carries in an inbox preview, through
    // `loadSenderIdentityContext` (Task 13c).
    private readonly identityAttribution: IdentityAttributionService,
  ) {}

  /** Bare array (legacy convenience): every internal caller besides the HTTP
   *  list route itself (currently only the `MessagingService` facade, kept
   *  backward-compatible on purpose). Uncapped cursor, `DEFAULT_LIST_LIMIT`
   *  ceiling, exactly the pre-ENG-253 behaviour. */
  async listConversations(userId: string): Promise<ConversationResponse[]>;
  /**
   * ENG-253: one cursor-paginated page of the caller's inbox, the shape
   * `GET /conversations` itself now returns. See `ConversationListPage`'s own
   * doc for the envelope and `buildConversationSummaries` for why a list row
   * carries `memberPreview`/`draftPreview`/`hasDraft` instead of the full
   * `members` roster and `draft` body the single-conversation read path
   * (`getConversation`) gets.
   */
  async listConversations(
    userId: string,
    options: { cursor?: string; limit?: number; mailboxIdentityId?: string },
  ): Promise<ConversationListPageWithStaffClaim>;
  async listConversations(
    userId: string,
    options?: { cursor?: string; limit?: number; mailboxIdentityId?: string },
  ): Promise<ConversationResponse[] | ConversationListPageWithStaffClaim> {
    // Overload dispatch: the facade's single-argument call keeps returning a
    // bare array; the HTTP list route always passes a (possibly empty)
    // second argument and gets the envelope back. `options` being merely
    // `undefined` vs. `{}` is what tells the two apart, not `cursor`/`limit`
    // themselves (both are legitimately omittable on a first-page fetch).
    const isPaginatedCall = options !== undefined;
    // Legacy bare-array callers keep the pre-ENG-253 DEFAULT_LIST_LIMIT
    // ceiling unchanged. The real HTTP route clamps to the DEFAULT_LIMIT/
    // MAX_LIMIT band `GetMessagesQuery` already established for message
    // history paging (30/100), rather than inventing a third ceiling for one
    // more list endpoint.
    const limit = isPaginatedCall
      ? Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
      : DEFAULT_LIST_LIMIT;
    const decodedCursor =
      isPaginatedCall && options?.cursor ? decodeCursor(options.cursor) : null;
    // Task 24: a mailbox filter is authorized once, before any query.
    const mailboxIdentityId = options?.mailboxIdentityId;
    if (mailboxIdentityId !== undefined) {
      await this.assertMayReadMailbox(userId, mailboxIdentityId);
    }

    // Order by last activity BEFORE the take so the retained subset is
    // DETERMINISTIC: the most-recently-active conversations first, which is
    // exactly what an over-cap inbox wants, rather than an arbitrary slice of
    // an unordered scan. "Last activity" mirrors the derived `updatedAt`
    // below: the newest non-deleted message's timestamp, falling back to the
    // conversation's own creation for an empty thread. The correlated MAX rides
    // the composite index messages (conversation_id, created_at); with no joins
    // on this builder, `.take()` emits a plain LIMIT (no distinct-pagination).
    //
    // ENG-255: the MAX() must skip exactly the messages the slice's own
    // ordering (via `lastByConvo` = `MessagingCoreService.lastMessagesByConversation`)
    // already skips as this viewer's "visible newest message": a message
    // this viewer hid for themself (`message_hides`, PRD-227) or a moderator
    // took down (`content_moderation`). Otherwise the slice and the ORDER BY
    // disagree: a thread whose only recent activity is invisible to this
    // viewer can still occupy one of the capped slots ahead of a thread with
    // older-but-visible activity, and then sort as if that invisible message
    // were its true last activity. The hides `NOT EXISTS`
    // below mirrors `MessagingCoreService`'s own `notHiddenForViewerPredicate`
    // (private to that service, so re-stated here), and the takedown
    // `NOT EXISTS` is the shared `notModeratedMessagePredicate`, both under
    // the `message` alias this correlated subquery already uses.
    const lastActivityExpression = `COALESCE(
        (SELECT MAX(message.created_at) FROM messages message
          WHERE message.conversation_id = participant.conversation_id
            AND message.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM message_hides hide
              WHERE hide.message_id = message.id AND hide.user_id = :userId
            )
            AND ${notModeratedMessagePredicate('message')}),
        (SELECT conversation.created_at FROM conversations conversation
          WHERE conversation.id = participant.conversation_id)
      )`;
    const queryBuilder = this.participants
      .createQueryBuilder('participant')
      .where('participant.user_id = :userId', { userId })
      .setParameter('messageSubjectType', MESSAGE_SUBJECT_TYPE)
      // The two "this thread is invisible to me" rules run in SQL, BEFORE the
      // cap, not in the loop below. They are still applied there as the exact
      // authority (the preview also skips moderator-withheld messages, which
      // this can't see), but pushing them down is what stops a cleared or
      // blocked thread from spending one of the capped slots and pushing a
      // live conversation off the end of a long-tenured member's inbox.
      //
      // Cleared ("delete for me"): the thread exists for this member only if
      // some message landed after their clear point.
      .andWhere(
        `(
          participant.cleared_at IS NULL
          OR EXISTS (
            SELECT 1 FROM messages message
            WHERE message.conversation_id = participant.conversation_id
              AND message.deleted_at IS NULL
              AND message.created_at > participant.cleared_at
          )
        )`,
      )
      // Blocked counterpart, either direction, on a 1:1 thread. Group and
      // official threads are exempt for the same reason as the loop below: they
      // have no single counterpart, and one block must not erase a whole group
      // from the member's inbox. Task 13c: a business mailbox thread is exempt
      // too, for the reason the loop below gives; identity-level blocking of
      // a business is Task 14's `identity_blocks`, applied just below.
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM conversation_participants other
          JOIN conversations convo ON convo.id = other.conversation_id
          WHERE other.conversation_id = participant.conversation_id
            AND other.user_id <> :userId
            AND convo.kind <> :groupKind
            AND convo.is_official = false
            AND NOT ${mailboxThreadPredicate('other.conversation_id')}
            AND EXISTS (
              SELECT 1 FROM blocks block
              WHERE (block.blocker_id = :userId AND block.blocked_id = other.user_id)
                 OR (block.blocked_id = :userId AND block.blocker_id = other.user_id)
            )
        )`,
        { groupKind: ConversationKind.Group },
      )
      // Task 13c fix round 1: a STAFF member blocked either way with the
      // customer of a mailbox thread is left out of it (see the loop below).
      // Task 14a: so is a staff member who has left the business. Task 14:
      // so are the customer and every staff member of a thread whose
      // customer blocked the business.
      .andWhere(
        `NOT ${seatExcludedFromMailboxPredicate('participant.conversation_id', ':userId')}`,
      );
    if (mailboxIdentityId !== undefined) {
      // Task 24: only the caller's own seats that speak for this mailbox, on
      // the same builder the keyset seek and `take(limit + 1)` below run on,
      // so a filtered page is exact and its cursor walks only this mailbox.
      // Every predicate above still applies, so a filtered list is always a
      // subset of the merged one.
      queryBuilder.andWhere('participant.identity_id = :mailboxIdentityId', {
        mailboxIdentityId,
      });
    }
    if (decodedCursor) {
      // Keyset seek: strictly OLDER activity than the cursor's row, with
      // `participant.id` (unique per caller-conversation pair) as the
      // tie-breaker for two rows sharing one instant, the same
      // `(column, id) < (:value, :id)` shape `cursorPaginate` uses, hand-
      // applied here because `lastActivityExpression` is a correlated
      // subquery: `cursorPaginate`'s generic signature can only express a
      // plain column.
      queryBuilder.andWhere(
        `(${lastActivityExpression}, participant.id) < (:cursorLastActivity, :cursorParticipantId)`,
        {
          cursorLastActivity: decodedCursor.createdAt.toISOString(),
          cursorParticipantId: decodedCursor.id,
        },
      );
    }
    // Fetch `limit + 1` rows to detect `hasMore` without a separate count
    // query (mirrors `cursorPaginate`). The raw `last_activity` column rides
    // along (`getRawAndEntities`, like `MessagesService.getMessages`'s own
    // `cursor_created_at`) so the next cursor is built from the EXACT value
    // the ORDER BY/WHERE just used, never a re-derived (and possibly
    // slightly different) `updatedAt`.
    const { entities: fetchedParts, raw } = await queryBuilder
      .addSelect(lastActivityExpression, 'last_activity')
      .orderBy(lastActivityExpression, 'DESC')
      .addOrderBy('participant.id', 'DESC')
      .take(limit + 1)
      .getRawAndEntities<{ participant_id: string; last_activity: string }>();
    const hasMore = fetchedParts.length > limit;
    const myParts = hasMore ? fetchedParts.slice(0, limit) : fetchedParts;
    if (!myParts.length) {
      return isPaginatedCall
        ? { data: [], pageInfo: { nextCursor: null, hasMore: false } }
        : [];
    }
    // ENG-253 trims `members`/`draft` ONLY on the paginated (real HTTP list
    // route) call. The legacy bare-array overload keeps `fullDetail: true`,
    // exactly its documented "pre-ENG-253 behaviour" contract above, so the
    // `MessagingService` facade (its only remaining caller) keeps returning
    // what it always has.
    const summaries = await this.buildConversationSummaries(myParts, userId, {
      fullDetail: !isPaginatedCall,
    });
    if (!isPaginatedCall) {
      return summaries;
    }
    const lastPart = myParts[myParts.length - 1]!;
    // There is no join, so every entity has its own raw row (mirrors
    // `MessagesService.getMessages`'s identical `raw.find` lookup).
    const lastRawRow = raw.find((row) => row.participant_id === lastPart.id);
    const nextCursor =
      hasMore && lastRawRow
        ? encodeCursor({
            createdAt: new Date(lastRawRow.last_activity),
            id: lastPart.id,
          })
        : null;
    return {
      data: summaries,
      pageInfo: { nextCursor, hasMore },
    };
  }

  /**
   * Task 24: the gate for every `?as=` mailbox filter (the inbox, search and
   * starred lists). It uses the read test, `isAllowedToActAs`, so a
   * moderation-removed persona's staff keep reading its threads, the way the
   * mailbox switcher lists it read-only; the member's own profile identity
   * passes too, since its staff set is the member. A caller who does not
   * staff the identity and a caller naming an identity that does not exist
   * both get the identical refusal, so the routes are no oracle for which
   * identities exist. It keeps the `IDENTITY_NOT_STAFF` code
   * `assertMayActAs` uses, which clients key on, with a message that fits a
   * read.
   */
  async assertMayReadMailbox(
    userId: string,
    mailboxIdentityId: string,
  ): Promise<void> {
    if (!(await this.identities.isAllowedToActAs(userId, mailboxIdentityId))) {
      throw new ForbiddenException({
        code: 'IDENTITY_NOT_STAFF',
        message: 'You cannot read this mailbox',
      });
    }
  }

  /**
   * Single-conversation read path (ENG-253): full detail for ONE conversation
   * the caller already has open. Returns the group's real member roster with
   * each member's read/delivered watermark (for "Seen by N") and the
   * caller's own full, untruncated draft, neither of which
   * `listConversations` sends on an inbox list row anymore. Shares
   * `buildConversationSummaries` with `listConversations` so the two can
   * never disagree on anything else.
   *
   * Throws `NotFoundException` for a conversation the caller cleared with no
   * newer message, or a 1:1 whose counterpart they've blocked/been blocked
   * by: the same "invisible to me" rules `listConversations` applies to drop
   * a row silently, surfaced here as 404 instead since a direct fetch has no
   * list to simply omit the row from.
   */
  async getConversation(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponseWithStaffClaim> {
    const part = await this.core.requireParticipant(conversationId, userId);
    const [summary] = await this.buildConversationSummaries([part], userId, {
      fullDetail: true,
    });
    if (!summary) {
      throw new NotFoundException('Conversation not found');
    }
    return summary;
  }

  /**
   * Shared batched hydration + per-row shaping for BOTH `listConversations`
   * (many rows, one inbox page) and `getConversation` (one row, the
   * single-conversation read path), extracted from the original single
   * `listConversations` body so the two routes can never drift on anything
   * except the two fields ENG-253 trimmed from list rows.
   *
   * `fullDetail` toggles ONLY: the full group roster with each member's
   * read/delivered watermark (`members`, `[]` when false) and the caller's
   * own full draft body (`draft`, omitted when false). Every other field,
   * including the new `memberPreview`/`draftPreview`/`hasDraft`, and every
   * DM-level watermark (`otherLastReadAt`/`otherLastReadInstant`/
   * `otherDeliveredAt`/`myLastReadAt`), is identical either way. The
   * caller is responsible for having already capped/paginated `myParts`
   * (this method does no capping of its own).
   */
  private async buildConversationSummaries(
    myParts: ConversationParticipant[],
    userId: string,
    { fullDetail }: { fullDetail: boolean },
  ): Promise<ConversationResponseWithStaffClaim[]> {
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
    // One query for the newest (non-deleted) message per conversation and one
    // grouped query for this user's unread counts — replaces the previous
    // per-conversation findOne + count (N+1).
    // ONE batched crop lookup for every group avatar in the inbox — never a
    // per-conversation query. DM/official threads carry no `avatarUrl`.
    // `replyRequiresConnection` (PRD-220): one call for every accepted
    // connection this caller has, not one `areConnected` check per row — so a
    // long inbox costs the same single query as `unreadByConvo`/`lastByConvo`.
    //
    // PRD-364: one batched read of every participant's (caller's own included)
    // messaging-privacy row, so the read-state gating below costs the same
    // single query as everything else here rather than one per conversation.
    //
    // Business mailboxes (Task 11): every distinct identity a seat on this
    // page carries (the caller's own and every counterpart's), in ONE query,
    // so telling a mailbox seat apart from an ordinary profile seat below
    // never turns into a per-conversation `IdentitiesService.getById` call.
    const participantIdentityIds = [
      ...new Set([
        ...myParts.map((part) => part.identityId),
        ...others.map((other) => other.identityId),
      ]),
    ];
    const [
      lastByConvo,
      unreadByConvo,
      groupAvatarCrops,
      acceptedConnections,
      privacyByUser,
    ] = await Promise.all([
      this.core.lastMessagesByConversation(convoIds, userId),
      this.core.unreadCountsByConversation(convoIds, userId),
      this.mediaCropService.getMany(
        convos.flatMap((convo) =>
          convo.kind === ConversationKind.Group && convo.avatarUrl
            ? [convo.avatarUrl]
            : [],
        ),
      ),
      this.connectionsService.allAcceptedConnectionUserIds(userId),
      this.preferencesService.getMessagingPrivacyForUsers([
        userId,
        ...others.map((o) => o.userId),
      ]),
    ]);
    // Every profile a row on this page renders, in ONE query: the caller's own
    // (they may be the sender of a thread's last message, and
    // `MessageResponse.sender` is non-nullable), every counterpart, AND every
    // sender of the previews themselves.
    //
    // That last set is why this runs after the batch above rather than before
    // it. Built from participants alone, the map had no entry for the official
    // sender, because an official thread's sender is the house account and the
    // house account is deliberately not a participant. `buildLastMessagePreview`
    // then fell through `requireAuthorSummary` to UNKNOWN_AUTHOR, so the
    // platform's own welcome message read as being from "Member" in the inbox.
    // `presentSenderIds` also drops the NULL sender of an erased author, which
    // `senderAuthorSummary` renders as a former member on its own.
    // Business mailboxes (Task 11): a claimed mailbox thread's `claimedBy` is
    // an ordinary profile author summary of the claimant, so their profile
    // rides this same batched query too, one lookup for the whole page.
    // Task 19: the colleagues a thread's latest claim change names (who
    // released it, whose claim was taken over) ride the same query.
    const claimantUserIds = convos
      .flatMap((convo) => [
        convo.claimedByUserId,
        convo.claimReleasedByUserId,
        convo.claimTakenOverFromUserId,
      ])
      .filter(
        (claimantUserId): claimantUserId is string => claimantUserId !== null,
      );
    // Task 13c: ONE identity context for the whole page, covering every
    // seat's identity (the header and every seat rule below) and every
    // preview's sender identity (`buildLastMessagePreview`), so the inbox
    // preview names a business sender exactly the way the thread does. The
    // preview senders are why this waits for `lastByConvo`: an official
    // thread's sender is the house account, which holds no seat here.
    const [relevantProfiles, identityContext] = await Promise.all([
      this.profiles.find({
        where: {
          userId: In([
            ...new Set([
              userId,
              ...others.map((other) => other.userId),
              ...presentSenderIds([...lastByConvo.values()]),
              ...claimantUserIds,
            ]),
          ]),
        },
      }),
      loadSenderIdentityContext(
        {
          identities: this.identities,
          identityAttribution: this.identityAttribution,
        },
        [
          ...participantIdentityIds,
          ...[...lastByConvo.values()].flatMap((message) =>
            message.senderIdentityId ? [message.senderIdentityId] : [],
          ),
          // Task 23 cleanup: the business a moved note names, so its
          // preview reads the business's current name.
          ...movedNoteMailboxIdentityIds([...lastByConvo.values()]),
        ],
        userId,
      ),
    ]);
    const identityKindById = identityContext.identityKindById;
    const profileByUser = new Map(
      relevantProfiles.map((profile) => [profile.userId, profile]),
    );
    const acceptedConnectionUserIds = new Set(acceptedConnections);
    // Reciprocal (PRD-364): a caller who has turned off their OWN read-receipt
    // sharing sees no one else's read state either, regardless of what each
    // individual counterpart/group member shares.
    const viewerSharesReadReceipts =
      privacyByUser.get(userId)?.shareReadReceipts ?? true;
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

    // Task 13c: which identity every seat of every DIRECT thread on this page
    // speaks for, computed ONCE per thread by `describeDirectThreadSeats`
    // (`mailbox-seats.ts`) and read by the batched `connectedSince` lookup
    // just below and by every field of the per-row build further down, so
    // they all agree on the same seats. That helper keeps the rule fix round
    // 1 of Task 13b introduced: a STAFF caller's customer is the one other
    // seat whose identity differs from the mailbox identity, found
    // deterministically whatever order the unordered read returned.
    const myPartByConvoId = new Map(
      myParts.map((myPart) => [myPart.conversationId, myPart]),
    );
    const threadSeatsByConvoId = new Map<string, DirectThreadSeats>();
    for (const convo of convos) {
      const myPart = myPartByConvoId.get(convo.id);
      threadSeatsByConvoId.set(
        convo.id,
        convo.kind === ConversationKind.Group || convo.isOfficial || !myPart
          ? NOT_A_DIRECT_THREAD
          : describeDirectThreadSeats(
              myPart.identityId,
              othersByConvo.get(convo.id) ?? [],
              identityKindById,
            ),
      );
    }
    // Task 14: the customer's blocks of a whole business, for every mailbox
    // thread on this page in one batched query: the caller's own blocks for
    // a customer, each thread's customer's for a staff caller.
    const identityBlockKeys = await loadMailboxIdentityBlockKeys(
      myParts.flatMap((myPart) => {
        const threadSeats = threadSeatsByConvoId.get(myPart.conversationId);
        return threadSeats
          ? mailboxIdentityBlockCandidates(myPart, threadSeats)
          : [];
      }),
      this.blockFilter,
    );
    // DES-225: `connectedSince` for every DM row in ONE query over all the
    // direct, non-official counterparts, never one lookup per conversation.
    // A STAFF caller asks for the CUSTOMER's own connection date. A
    // customer's view of a mailbox thread asks for nothing, since that field
    // reads null there (see its own comment further down).
    const connectedSinceByCounterpart =
      await this.connectionsService.acceptedSinceByCounterpart(
        userId,
        [...threadSeatsByConvoId.values()].flatMap((threadSeats) =>
          threadSeats.mailboxIdentityId && !threadSeats.isCallerMailboxSeat
            ? []
            : threadSeats.counterpartSeats.map((seat) => seat.userId),
        ),
      );

    // PRD-348: batched, ONE query for the whole page. See
    // `MessagingCoreService.hasUnreadMentionByConversation`'s own doc for why
    // this re-derives the mention from the message body rather than joining
    // the best-effort `Notification` row the send-time fan-out writes.
    const mentionByConvo = await this.core.hasUnreadMentionByConversation(
      convoIds,
      userId,
      profileByUser.get(userId)?.slug,
    );

    // Lazy-clear (PRD-349): an expired TIMED mute self-heals the instant this
    // participant's row is next read here, so `notCurrentlyMutedPredicate`
    // callers (push) don't have to wait for a write that may never come.
    // Collected rather than awaited per-row so a long inbox still costs ONE
    // extra round trip at most, not N.
    const expiredMuteUpdates: Promise<unknown>[] = [];

    const summaries: ConversationResponseWithStaffClaim[] = [];
    for (const part of myParts) {
      const convo = convoById.get(part.conversationId);
      if (!convo) {
        continue;
      }
      const isGroup = convo.kind === ConversationKind.Group;
      const convoOthers = othersByConvo.get(convo.id) ?? [];
      // Task 13c: see `threadSeatsByConvoId` above. `NOT_A_DIRECT_THREAD`
      // for a group or official thread.
      const threadSeats =
        threadSeatsByConvoId.get(convo.id) ?? NOT_A_DIRECT_THREAD;
      const { isCallerMailboxSeat, mailboxIdentityId, counterpartSeats } =
        threadSeats;
      // A customer's own view of a mailbox thread: every other seat is staff
      // of the one business, and no field below names any one of them.
      const isCustomerViewOfMailbox =
        Boolean(mailboxIdentityId) && !isCallerMailboxSeat;
      // A person-to-person block severs an ordinary 1:1 DM. Task 13c: on a
      // mailbox thread the rule is asymmetric. The CUSTOMER's view keeps the
      // business thread whatever personal blocks they hold, since hiding it
      // would tell them that person works there. A STAFF member blocked
      // either way with the customer loses the thread
      // (`isStaffSeatExcludedFromMailbox`, fix round 1), so a customer who
      // blocked someone for their safety stays out of that person's sight,
      // while every colleague without a block keeps the thread and the
      // business keeps answering. A block between colleagues changes nothing.
      // Task 14a: a staff member who has left the business loses the thread
      // by the same call, and gets it back if they are seated again.
      // Task 14: a customer who blocked the business as a whole
      // (`identity_blocks`) loses the thread, and so does every staff member
      // of it, through the same call (`isSeatExcludedFromMailbox`). The SQL
      // pre-filter in `listConversations` carries the same rules.
      if (
        !isGroup &&
        !convo.isOfficial &&
        (mailboxIdentityId
          ? isSeatExcludedFromMailbox(
              part,
              threadSeats,
              blockedCounterparts,
              identityBlockKeys,
            )
          : convoOthers.some((o) => blockedCounterparts.has(o.userId)))
      ) {
        continue;
      }
      // 1:1 thread: the single counterpart. Official/welcome AND group threads
      // have no single "other participant" (the client shows the org identity
      // or the group title instead), so `first` stays undefined and
      // `otherParticipant` stays null.
      const first = convo.isOfficial || isGroup ? undefined : convoOthers[0];
      // Task 13c: `renderDirectCounterpart` (`mailbox-seats.ts`) renders the
      // header for every direct thread: the customer's own profile for a
      // STAFF caller (fix round 2 of Task 13b), the business itself for a
      // customer, and an ordinary member's profile otherwise. A header
      // describes the whole business, so it names no staff member; per-message
      // attribution names the person who actually wrote.
      const otherParticipant: AuthorSummary | null =
        convo.isOfficial || isGroup
          ? null
          : renderDirectCounterpart(
              threadSeats,
              identityKindById,
              identityContext.identityDescriptionById,
              profileByUser,
            );
      // PRD-340: the one-tap-reply state for this DM, from THIS caller's
      // side; see `replyGateFor`. `replyRequiresConnection` mirrors it
      // (`!== "open"`) for existing callers; a blocked counterpart never
      // reaches here (the `continue` above already dropped the row).
      const replyGate =
        !isGroup && !convo.isOfficial && !!first
          ? this.replyGateFor(
              convo,
              userId,
              // Business mailboxes (fix round 1, Task 13b): on a mailbox
              // thread the connection input is false on both sides of it, even
              // when the customer really is connected to one staff member as a
              // person. A connection is between two people, and the thread is
              // with the business, the same reason `connectedSince` reads null
              // on the customer's side. A customer who personally knows
              // someone on staff therefore waits for the BUSINESS to send its
              // first reply, the same as any other customer, and the thread's
              // open state stays a property of the thread (who initiated,
              // whether it already opened) that reads the same on every fetch.
              // `MessagesService.sendMessageWithOutcome` enforces this same
              // rule at send time. Task 13c: a thread whose seats cannot be
              // attributed (`counterpartSeats` empty) also reads false.
              !mailboxIdentityId &&
                counterpartSeats.length === 1 &&
                acceptedConnectionUserIds.has(counterpartSeats[0]!.userId),
            )
          : 'open';
      const replyRequiresConnection =
        !isGroup && !convo.isOfficial && !!first ? replyGate !== 'open' : false;
      // Group roster: this caller's own participant row (`part`) + every other
      // participant. `groupParticipants` feeds THREE derived views below:
      // `activeMemberCount` (always the true count), `memberPreview` (always,
      // capped avatar-stack), and `members` (only on the single-conversation
      // read path: ENG-253 stopped shipping the full roster + watermarks on
      // an inbox list row).
      const groupParticipants = isGroup ? [part, ...convoOthers] : [];
      const activeMemberCount = groupParticipants.filter(
        (p) => p.leftAt == null,
      ).length;
      const memberPreview = isGroup
        ? this.core.buildMemberPreview(groupParticipants, profileByUser)
        : [];
      const members =
        isGroup && fullDetail
          ? this.core.buildMemberSummaries(
              groupParticipants,
              profileByUser,
              userId,
              privacyByUser,
            )
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
      // PRD-349: a TIMED mute past its expiry reads (and is persisted) as
      // unmuted the moment this row is read, rather than staying stuck muted
      // until the member happens to mute/unmute again. See `mutedUntil`'s
      // own doc on the entity for why this is the lazy-clear side of that
      // contract.
      if (
        part.muted &&
        part.mutedUntil &&
        part.mutedUntil.getTime() <= Date.now()
      ) {
        part.muted = false;
        part.mutedUntil = null;
        expiredMuteUpdates.push(
          this.participants.update(part.id, {
            muted: false,
            mutedUntil: null,
          }),
        );
      }
      const latestOf = (values: ReadonlyArray<Date | null>): Date | null =>
        values.reduce<Date | null>(
          (latest, value) =>
            value && (!latest || value > latest) ? value : latest,
          null,
        );
      // Read state, gated and valued from ONE list of seats (fix round 4 of
      // Task 13b, generalised by Task 13c). The seats that may contribute are
      // `counterpartSeats` (see its own doc in `mailbox-seats.ts`): the
      // customer's own seat for a STAFF caller, every staff seat for a
      // customer (the collapsed read receipt of Task 11: a customer's
      // message reads as read once ANY staff seat has read it), the single
      // counterpart of an ordinary DM, and none for a thread whose seats
      // cannot be attributed.
      //
      // PRD-364 is reciprocal: the caller sees read state only while they
      // share read receipts themselves, and only from seats whose own person
      // shares them. Task 13c applies that per seat BEFORE collapsing, so a
      // staff member who turned read receipts off never contributes to what
      // the customer sees, whatever order the seats arrived in. Both the gate
      // (`canSeeOtherReadState`) and the two values below read this same
      // `otherReadStateSeats`, so the gate and the value always describe the
      // same people.
      const otherReadStateSeats = viewerSharesReadReceipts
        ? counterpartSeats.filter(
            (seat) => privacyByUser.get(seat.userId)?.shareReadReceipts ?? true,
          )
        : [];
      const canSeeOtherReadState = otherReadStateSeats.length > 0;
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
              userId,
              identityContext,
              part.identityId,
            )
          : null,
        unreadCount: unreadByConvo.get(convo.id) ?? 0,
        // `conversations` has no updated_at column (schema is migration-owned
        // and this workstream adds none), so last activity is derived: the
        // newest message, or the thread's own creation for an empty thread.
        updatedAt: (
          clearedLastMessage?.createdAt ?? convo.createdAt
        ).toISOString(),
        // PRD-364: reciprocal, withheld unless BOTH the caller and the
        // counterpart share read receipts. `myLastReadAt` is the caller's own
        // watermark, so it is unaffected. Task 13c: the latest watermark
        // across `otherReadStateSeats`, the same seats the gate above read.
        // For a STAFF caller that is the CUSTOMER's own seat (fix rounds 3
        // and 4 of Task 13b), so a colleague having read a message never
        // reads as the customer having read it. For a customer it is every
        // staff seat that shares read receipts.
        otherLastReadAt: canSeeOtherReadState
          ? (latestOf(
              otherReadStateSeats.map((seat) => seat.lastReadAt),
            )?.toISOString() ?? null)
          : null,
        // PRD-351: the same gate and the same seats, applied to the real read
        // INSTANT alongside the watermark above. See
        // `ConversationParticipant.lastReadInstant`'s own doc for why the two
        // are distinct columns.
        otherLastReadInstant: canSeeOtherReadState
          ? (latestOf(
              otherReadStateSeats.map((seat) => seat.lastReadInstant),
            )?.toISOString() ?? null)
          : null,
        myLastReadAt: part.lastReadAt?.toISOString() ?? null,
        // The delivered watermark reads the same `counterpartSeats` (Task
        // 13b, generalised by Task 13c): the customer's own for a STAFF
        // caller, and for a customer the moment ANY staff seat's device has
        // the message.
        otherDeliveredAt:
          latestOf(
            counterpartSeats.map((seat) => seat.deliveredAt),
          )?.toISOString() ?? null,
        // Presence and the frontend's report/block subject are keyed by this
        // id. A customer's own view of a mailbox thread gets null (Task 13b):
        // a business has no human counterpart for the client to correlate,
        // and one staff member's id would let a customer ask whether that
        // person is online. A STAFF caller gets the CUSTOMER's id (fix round
        // 1 of Task 13b), found deterministically among colleague seats. A
        // thread whose seats cannot be attributed gets null (Task 13c).
        otherParticipantId: isCustomerViewOfMailbox
          ? null
          : (counterpartSeats[0]?.userId ?? null),
        // Business mailboxes (Task 11): see `mailboxIdentityId`'s own doc on
        // `ConversationResponse` for exactly when this is set.
        mailboxIdentityId,
        // Business mailboxes (Task 13b): who claimed a mailbox thread is
        // information for the mailbox's own staff, the colleague-facing
        // purpose the claim feature exists for, so only a STAFF caller of
        // this mailbox receives the claimant's author summary. Task 13c fix
        // round 1: `claimedAt` follows the same rule, since its changes
        // across release and re-claim trace staff handovers.
        claimedBy:
          isCallerMailboxSeat && mailboxIdentityId && convo.claimedByUserId
            ? toAuthorSummary(profileByUser.get(convo.claimedByUserId))
            : null,
        claimedAt:
          isCallerMailboxSeat && mailboxIdentityId
            ? (convo.claimedAt?.toISOString() ?? null)
            : null,
        // Task 19: who last released the claim, when, and whose claim the
        // current claimant took over, under the same staff-only rule as
        // `claimedBy`, since each names a person who staffs the business.
        // The claimant's user id rides the same rule, so a colleague can pass
        // it to take-over as `fromUserId`.
        ...(isCallerMailboxSeat && mailboxIdentityId
          ? staffClaimFields(convo, profileByUser)
          : NO_STAFF_CLAIM_FIELDS),
        replyRequiresConnection,
        replyGate,
        // A connection is a relationship between two people. A customer's own
        // view of a mailbox thread gets null, since the business holds no
        // personal connection with the customer (Task 13b). A STAFF caller
        // reads their own connection with the CUSTOMER, the same seat the
        // batched `connectedSinceByCounterpart` lookup above asked about.
        // Group and official threads carry no counterpart seats, so null.
        connectedSince: isCustomerViewOfMailbox
          ? null
          : counterpartSeats[0]
            ? (connectedSinceByCounterpart
                .get(counterpartSeats[0].userId)
                ?.toISOString() ?? null)
            : null,
        kind: isGroup ? 'group' : 'direct',
        title: isGroup ? convo.title : null,
        avatarUrl: isGroup ? toImageUrl(convo.avatarUrl) : null,
        avatarCrop: isGroup
          ? cropFor(convo.avatarUrl, groupAvatarCrops)
          : undefined,
        memberCount: activeMemberCount,
        members,
        memberPreview,
        isOfficial: convo.isOfficial,
        muted: part.muted,
        mutedUntil: part.mutedUntil?.toISOString() ?? null,
        // PRD-349: the caller's own mute MODE, alongside the ladder above.
        muteMode: part.muteMode,
        hasUnreadMention: mentionByConvo.get(convo.id) ?? false,
        pinnedAt: part.pinnedAt?.toISOString() ?? null,
        favorite: part.favoritedAt != null,
        archivedAt: part.archivedAt?.toISOString() ?? null,
        markedUnreadAt: part.markedUnreadAt?.toISOString() ?? null,
        // ENG-253: the full body is sent only on the single-conversation
        // read path (`fullDetail`); a list row gets the bounded preview +
        // boolean below instead, always (both paths).
        draft: fullDetail ? part.draft : undefined,
        draftPreview: part.draft ? part.draft.slice(0, 120) : null,
        hasDraft: !!part.draft && part.draft.length > 0,
        hasLeft: isGroup ? part.leftAt != null : false,
        description: isGroup ? convo.description : null,
        dissolvedAt: isGroup
          ? (convo.dissolvedAt?.toISOString() ?? null)
          : null,
        leftReason: isGroup
          ? computeGroupLeftReason({
              leftAt: part.leftAt,
              removedAt: part.removedAt,
              dissolvedAt: convo.dissolvedAt,
            })
          : null,
        // Only an active (not-left, not-dissolved) owner/admin ever sees the
        // live token; everyone else gets null even if one exists.
        inviteToken:
          isGroup &&
          !part.leftAt &&
          !convo.dissolvedAt &&
          (part.role === ConversationRole.Owner ||
            part.role === ConversationRole.Admin)
            ? convo.inviteToken
            : null,
        // Computed exactly like `GroupsService.toGroupConversationResponse`'s
        // matching fields: owner/admin only, active, not dissolved for
        // `canManageInviteLink`; owner only, active, not dissolved for the
        // other two (an admin manages the invite link but never ends or
        // hands off the group). `false` outright for a DM (`isGroup` false).
        canManageInviteLink:
          isGroup &&
          !part.leftAt &&
          !convo.dissolvedAt &&
          (part.role === ConversationRole.Owner ||
            part.role === ConversationRole.Admin),
        canTransferOwnership:
          isGroup &&
          !part.leftAt &&
          !convo.dissolvedAt &&
          part.role === ConversationRole.Owner,
        canDissolve:
          isGroup &&
          !part.leftAt &&
          !convo.dissolvedAt &&
          part.role === ConversationRole.Owner,
        pendingInvites: [],
        ...(isGroup
          ? this.core.groupCapabilities(part.role, part.leftAt != null)
          : {}),
      });
    }
    // Most recently active first. ISO-8601 UTC strings are fixed-width, so
    // lexicographic order is chronological order.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (expiredMuteUpdates.length) {
      await Promise.all(expiredMuteUpdates);
    }
    return summaries;
  }

  /** Count of the caller's conversations with unread messages — the nav DM
   *  badge's cheap single number, so it never fetches the whole inbox. */
  unreadConversationCount(userId: string): Promise<number> {
    return this.core.unreadConversationCount(userId);
  }

  /**
   * Advance the caller's read watermark on a conversation.
   *
   * `upToMessageId` names the NEWEST message the client actually rendered, and
   * is the accurate form: the watermark becomes that message's own
   * `created_at`, read straight from the row. Without it the watermark was
   * always `now()`, so a message that landed between the client's last fetch
   * and its `read` frame was marked read without ever being shown — the unread
   * count under-reported and the sender saw "seen" on a message the recipient
   * never saw.
   *
   * `lastReadAt` is the older, client-clock form the web app still sends. It is
   * honoured but clamped to `now()`, so a device whose clock runs fast can
   * never stamp a watermark into the future; a device running slow simply
   * leaves more messages unread, which is the safe direction.
   *
   * With neither, the watermark stays `now()` — the previous behaviour.
   */
  async markRead(
    conversationId: string,
    userId: string,
    options?: { upToMessageId?: string; lastReadAt?: string },
  ): Promise<{ ok: true }> {
    // Active participation (BE-MSG-09): a read receipt is BROADCAST to the
    // room, so a blocked DM counterpart could otherwise keep telling the
    // blocker "I read your message", and a removed group member could keep
    // firing `read` frames into a thread they can no longer see.
    await this.core.requireActiveParticipant(conversationId, userId);
    let watermark: Date | string | null = null;
    if (options?.upToMessageId) {
      watermark = await this.core.messageCreatedAt(
        conversationId,
        options.upToMessageId,
      );
      if (!watermark) {
        throw new NotFoundException('Message not found in this conversation');
      }
    } else if (options?.lastReadAt) {
      watermark = options.lastReadAt;
    }
    // PRD-364: the delivered watermark is a read receipt by another name. A
    // reader who has turned off read-receipt sharing must not advance it from
    // here: `otherDeliveredAt` (and the per-message `deliveredAt` that
    // `MessagingCoreService` derives from the same column) would otherwise
    // tell the sender the exact moment that member opened the thread, one
    // message later, which is precisely what the toggle promises to withhold.
    //
    // `markDelivered` below is deliberately NOT gated this way. It reports
    // receipt by a DEVICE (the recipient's client acking an inbound message as
    // it arrives), which happens whether or not the member ever opened the
    // thread, and the read-receipt toggle does not cover it.
    const sharesReadReceipts = (
      await this.preferencesService.getMessagingPrivacy(userId)
    ).shareReadReceipts;
    const deliveredWatermark = (
      expression: string,
    ): QueryDeepPartialEntity<ConversationParticipant> =>
      sharesReadReceipts ? { deliveredAt: () => expression } : {};
    // Read implies delivered, so advance the delivered watermark in the same
    // write whenever this reader shares read receipts: a reader who opens the
    // thread (and never sent an explicit socket ack) still lets the sender see
    // at least a "delivered" tick, and the two watermarks can never cross
    // (delivered can't lag read for the same view).
    //
    // Both stamps go through GREATEST so the watermark only ever moves forward:
    // an out-of-order `read` frame (or a stale queued one from a reconnect)
    // can't walk a member's unread count backwards. GREATEST ignores a NULL
    // side, so a first-ever read still lands. Timestamps are compared in the
    // DB, against DB-generated message timestamps, never against the app
    // server's own clock.
    const update = this.participants
      .createQueryBuilder()
      .update(ConversationParticipant);
    if (watermark) {
      update
        .set({
          lastReadAt: () =>
            'GREATEST(last_read_at, LEAST(:watermark::timestamptz, now()))',
          ...deliveredWatermark(
            'GREATEST(delivered_at, LEAST(:watermark::timestamptz, now()))',
          ),
          // PRD-351: the real read INSTANT, distinct from the watermark
          // above, see `ConversationParticipant.lastReadInstant`'s own doc
          // for why this is `now()` and never GREATEST-clamped or
          // watermark-derived.
          lastReadInstant: () => 'now()',
          // Re-opening/reading a thread clears a manual "mark unread"
          // (PRD-225) — this is the ONLY place that ever clears it, so it
          // can't be silently undone by an inbox refetch or an unrelated
          // preference toggle (see `ConversationParticipant.markedUnreadAt`).
          markedUnreadAt: null,
        })
        .setParameter(
          'watermark',
          watermark instanceof Date ? watermark.toISOString() : watermark,
        );
    } else {
      update.set({
        lastReadAt: () => 'GREATEST(last_read_at, now())',
        ...deliveredWatermark('GREATEST(delivered_at, now())'),
        lastReadInstant: () => 'now()',
        markedUnreadAt: null,
      });
    }
    await update
      .where('conversation_id = :conversationId', { conversationId })
      .andWhere('user_id = :userId', { userId })
      .execute();
    const updated = await this.participants.findOne({
      where: { conversationId, userId },
    });
    const lastReadAt = updated?.lastReadAt ?? new Date();
    // PRD-364: the READ watermark write above always happens (this reader's
    // own unread counts must keep working), but the LIVE relay is reciprocal:
    // skip the emit entirely when this reader has turned off read-receipt
    // sharing, so `ChatGateway.handleMessageRead` never learns of it and no
    // other participant's client is told this member read anything. Reuses the
    // single privacy read taken before the update (which also decides whether
    // the delivered stamp moves), so `markRead` still costs one preferences
    // query, not two.
    if (sharesReadReceipts) {
      this.eventEmitter.emit(MESSAGE_READ, {
        conversationId,
        userId,
        lastReadAt,
      } satisfies MessageReadEvent);
    }
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
    // Broadcast like `markRead`, gated identically (BE-MSG-09).
    await this.core.requireActiveParticipant(conversationId, userId);
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

  /** Maximum span a TIMED mute may cover (PRD-349): a sane ceiling so a
   *  client bug (or a tampered PATCH) can't silence a thread indefinitely
   *  under the guise of a "duration". "Always" (explicit forever) is the
   *  separate `mutedUntil: null` case below, not this cap. */
  private static readonly MAX_MUTE_DURATION_MS = 400 * 24 * 60 * 60 * 1000;

  /**
   * Mute/unmute a conversation for THIS caller only, with an optional TIMED
   * expiry (PRD-349: 8 hours / 1 week / "Always"). `mutedUntil`:
   *  - unmuting (`muted: false`): always clears any expiry too, regardless of
   *    what was passed, so a stale expiry can never resurrect itself.
   *  - muting with `mutedUntil` an ISO timestamp: must be strictly in the
   *    future and inside `MAX_MUTE_DURATION_MS`, or the PATCH is rejected,
   *    since a client mistake (or a stale clock) must not silently mute
   *    forever or fail deep in a DB constraint.
   *  - muting with `mutedUntil: null`: explicit "Always"; mutes forever.
   *  - muting with `mutedUntil` omitted (the pre-PRD-349 bare
   *    `{ muted: true }` shape): leaves whatever expiry (or lack of one)
   *    this participant already had, so a bare re-mute can't silently
   *    downgrade an existing timed mute to forever.
   *
   * ENG-247: writes only the columns this preference owns, via a targeted
   * `.update()` rather than a load-then-`save()` of the whole participant
   * row. A full-row `save()` re-persists every OTHER column exactly as it
   * was when THIS request read the row, so a `markRead` watermark or a
   * `buildPostResult` unarchive landing on the same row between that read
   * and this write is silently overwritten back to its stale value. Every
   * other per-preference setter below (`setPinned`, `setFavorite`,
   * `setArchived`, `setMarkedUnread`, `setDraft`) follows the same shape.
   */
  async setMuted(
    conversationId: string,
    userId: string,
    muted: boolean,
    mutedUntil?: string | null,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    const updateValues: QueryDeepPartialEntity<ConversationParticipant> = {
      muted,
    };
    if (!muted) {
      updateValues.mutedUntil = null;
    } else if (mutedUntil === null) {
      updateValues.mutedUntil = null;
    } else if (mutedUntil !== undefined) {
      const expiry = new Date(mutedUntil);
      const now = Date.now();
      if (
        Number.isNaN(expiry.getTime()) ||
        expiry.getTime() <= now ||
        expiry.getTime() - now > ConversationsService.MAX_MUTE_DURATION_MS
      ) {
        throw new BadRequestException(
          'mutedUntil must be a future timestamp within the maximum mute duration',
        );
      }
      updateValues.mutedUntil = expiry;
    }
    // `mutedUntil` omitted while muting (the bare `{ muted: true }` shape)
    // never enters `updateValues`, so the column is left untouched, exactly
    // as the doc above promises.
    await this.participants.update({ conversationId, userId }, updateValues);
    return { ok: true };
  }

  /**
   * PRD-349: set THIS caller's own mute MODE for a conversation:
   * `ConversationMuteMode.All` (the ordinary `muted`/`mutedUntil` ladder
   * `setMuted` above already governs) or `MentionsOnly` (never the plain
   * message push; a push for a message that `@`-mentions the caller still
   * arrives, enforced in `PushMessageListener.eligibleMessagePushRecipientUserIds`
   * via `isMutedForPlainMessagePush`). Deliberately independent of `setMuted`:
   * picking "Mentions only" from the row menu does not itself touch `muted`/
   * `mutedUntil`, and picking one of the timed-mute durations does not touch
   * this column either; see `ConversationParticipant.muteMode`'s own doc for
   * why the two axes are allowed to coexist rather than being collapsed into
   * one.
   *
   * ENG-247: a targeted `.update()` on this one column, so this write can
   * never race `setMuted`'s own targeted update and clobber it back to a
   * stale value (see `setMuted`'s doc for the general shape every setter here
   * follows).
   */
  async setMuteMode(
    conversationId: string,
    userId: string,
    muteMode: ConversationMuteMode,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    await this.participants.update({ conversationId, userId }, { muteMode });
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
   *
   * ENG-248: a fresh pin (the only branch that can push the caller over the
   * cap) counts and writes inside one transaction that first takes a
   * transaction-scoped `pg_advisory_xact_lock` keyed on the caller, the same
   * per-user serialisation `SubprofilesService` uses for its create cap.
   * Without it, two parallel pins (a double-tap, or two devices) can both read
   * the same under-cap count before either write lands, and both pass. The two
   * racing pins may target different conversations, so no single participant
   * row is a shared anchor; the advisory lock is one O(1) key that leaves
   * every other write to this member's participant rows (read watermarks,
   * unarchive on a new message, mute, draft) unblocked. Unpinning, and
   * re-pinning an already-pinned thread, never need the lock: neither one can
   * increase how many conversations this caller has pinned.
   */
  async setPinned(
    conversationId: string,
    userId: string,
    pinned: boolean,
  ): Promise<{ ok: true }> {
    const part = await this.core.requireParticipant(conversationId, userId);
    if (!pinned) {
      await this.participants.update(
        { conversationId, userId },
        { pinnedAt: null },
      );
      return { ok: true };
    }
    if (part.pinnedAt != null) {
      await this.participants.update(
        { conversationId, userId },
        { pinnedAt: new Date() },
      );
      return { ok: true };
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `conversation_pin:${userId}`,
      ]);
      const otherPinnedCount = await manager.count(ConversationParticipant, {
        where: {
          userId,
          pinnedAt: Not(IsNull()),
          conversationId: Not(conversationId),
        },
      });
      if (otherPinnedCount >= ConversationsService.MAX_PINNED_CONVERSATIONS) {
        throw new ConflictException('You can pin up to 3 chats.');
      }
      await manager.update(
        ConversationParticipant,
        { conversationId, userId },
        { pinnedAt: new Date() },
      );
    });
    return { ok: true };
  }

  /**
   * Favorite/unfavorite a conversation for THIS caller only (mirrors `setMuted`),
   * stamping `favoritedAt` with the app clock (NULL = not favorited). No cap.
   * ENG-247: a targeted `.update()` on this one column
   * (see `setMuted`'s doc for why).
   */
  async setFavorite(
    conversationId: string,
    userId: string,
    favorite: boolean,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { favoritedAt: favorite ? new Date() : null },
    );
    return { ok: true };
  }

  /**
   * Archive/unarchive a conversation for THIS caller only (mirrors `setMuted`),
   * stamping `archivedAt` with the app clock (NULL = not archived). No cap,
   * and always allowed either direction — unlike a group leave/removal this
   * never touches send/read access, purely an inbox-declutter preference.
   * `MessagingCoreService.buildPostResult` independently clears `archivedAt`
   * for every participant the moment a fresh message lands, so archiving is
   * never the reason a reply goes unseen.
   *
   * ENG-247: a targeted `.update()` on this one column, so this write can never race `buildPostResult`'s
   * own targeted unarchive UPDATE and clobber it back to a stale `archivedAt`
   * (see `setMuted`'s doc for the general shape).
   */
  async setArchived(
    conversationId: string,
    userId: string,
    archived: boolean,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { archivedAt: archived ? new Date() : null },
    );
    return { ok: true };
  }

  /**
   * Mark/unmark a conversation unread for THIS caller only (PRD-225),
   * stamping `markedUnreadAt` with the app clock (NULL = not manually
   * marked). Mirrors `setArchived`/`setFavorite`'s shape, but note this is
   * NOT the read watermark: `lastReadAt` is untouched here (and can only ever
   * move forward, via `markRead`'s GREATEST), so marking a thread unread
   * cannot walk it backward. Re-opening the thread (a genuine `markRead`
   * call) is the only thing that clears this flag back to NULL.
   *
   * ENG-247: a targeted `.update()` on this one column, so this write can never race `markRead`'s own
   * targeted UPDATE (which clears `markedUnreadAt` as part of advancing the
   * read watermark) and clobber it back to a stale value (see `setMuted`'s
   * doc for the general shape).
   */
  async setMarkedUnread(
    conversationId: string,
    userId: string,
    markedUnread: boolean,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { markedUnreadAt: markedUnread ? new Date() : null },
    );
    return { ok: true };
  }

  /**
   * Sync THIS caller's own unsent composer text for a conversation to the
   * server — the cross-device layer on top of the client's always-on
   * localStorage copy (see the entity's own doc). An empty string clears the
   * stored draft, mirroring `features/messages/drafts.ts`'s own "empty text
   * drops the key" convention. The client debounces calls to this (never one
   * per keystroke) — nothing here rate-limits it further, matching `setMuted`/
   * `setPinned`/`setFavorite`, which lean on the endpoint's own `Throttle`.
   *
   * ENG-247: a targeted `.update()` on this one column, so a debounced draft sync racing another
   * preference write or a read-watermark update can't clobber it (see
   * `setMuted`'s doc for the general shape).
   */
  async setDraft(
    conversationId: string,
    userId: string,
    draft: string,
  ): Promise<{ ok: true }> {
    await this.core.requireParticipant(conversationId, userId);
    await this.participants.update(
      { conversationId, userId },
      { draft: draft.length > 0 ? draft : null },
    );
    return { ok: true };
  }

  /**
   * The business/persona/company identity a thread belongs to, i.e. the
   * mailbox `claim`/`release` act on. A business mailbox seats one
   * `ConversationParticipant` row per staff member, all sharing that ONE
   * identity, alongside the customer's own profile-identity row, so the
   * mailbox identity is the one seat in the thread that is not a plain
   * member acting as themselves.
   *
   * Callers are expected to have already run `MessagingCoreService
   * .requireParticipant` for this exact `conversationId`, so the empty-seats
   * case below is a defensive fallback that no real caller reaches.
   * `BadRequestException` covers a real, ordinary member-to-member
   * thread, where claiming has no meaning, and is safe to raise here because
   * the caller already knows this conversation exists (they hold a seat in
   * it). A conversation somehow carrying more than one distinct non-profile
   * identity is a data-integrity fault, so that case throws outright and
   * leaves the choice between those identities unmade.
   */
  private async resolveMailboxIdentityId(
    conversationId: string,
  ): Promise<string> {
    const seats = await this.participants.find({
      where: { conversationId },
      select: { identityId: true },
    });
    if (seats.length === 0) {
      throw new NotFoundException('Conversation not found');
    }
    const identityIds = [...new Set(seats.map((seat) => seat.identityId))];
    const identities = await Promise.all(
      identityIds.map((identityId) => this.identities.getById(identityId)),
    );
    const mailboxIdentities = identities.filter(
      (identity): identity is Identity =>
        identity !== null && identity.kind !== IdentityKind.Profile,
    );
    if (mailboxIdentities.length === 0) {
      throw new BadRequestException({
        code: 'CONVERSATION_NOT_A_MAILBOX',
        message: 'Only a shared business mailbox thread can be claimed',
      });
    }
    if (mailboxIdentities.length > 1) {
      throw new Error(
        `Conversation ${conversationId} carries more than one business mailbox identity`,
      );
    }
    // Exactly one element at this point: neither `=== 0` nor `> 1` above.
    return mailboxIdentities[0]!.id;
  }

  /**
   * Claim an unclaimed thread, or find out who beat the caller to it. Two
   * staff members hitting Claim at the same instant must settle on exactly
   * one winner, so the claim itself is a single conditional UPDATE guarded on
   * `claimed_by_user_id IS NULL`: only the request whose UPDATE actually
   * matches a row (`affected === 1`) becomes the claimant. Postgres commits
   * that guard atomically as part of the write itself, closing the window a
   * separate read-then-write would leave open for a second caller to slip
   * through. A caller who loses the race (`affected === 0`) re-reads
   * the row and is told the real claimant, with `isNewlyClaimed: false`; a
   * caller re-claiming their own already-claimed thread reads back their own
   * id with `isNewlyClaimed: true`. Task 19: a loser whose re-read finds the
   * thread unclaimed (someone released it in between) reads
   * `claimedByUserId: null`, and every response names the claimant through
   * `claimedBy`, rendered as the conversation read renders it for staff.
   *
   * Task 19: the same UPDATE clears the release columns and
   * `claimTakenOverFromUserId`, so the row holds the latest change only
   * (see `Conversation.claimReleasedByUserId`), and a claim that changed the
   * row emits `CONVERSATION_CLAIM_CHANGED` once it has committed.
   *
   * Gated in two steps, in order: `requireParticipant` first, so a caller
   * with no relationship to this conversation at all gets the same plain
   * "not a participant" refusal every other read/write in this service
   * gives them, learning nothing about whether the id even exists; then
   * `assertMayActAs`, which refuses a participant (a customer, say) who is
   * not staff for the mailbox this thread belongs to.
   */
  async claim(conversationId: string, userId: string): Promise<ClaimResponse> {
    await this.core.requireParticipant(conversationId, userId);
    const mailboxIdentityId =
      await this.resolveMailboxIdentityId(conversationId);
    await this.identities.assertMayActAs(userId, mailboxIdentityId);

    const claimedAt = await claimUnclaimedConversation(
      this.conversations,
      conversationId,
      userId,
    );

    if (claimedAt) {
      this.emitClaimChanged({
        conversationId,
        mailboxIdentityId,
        change: 'claimed',
        isImplicit: false,
        actorUserId: userId,
        claimedByUserId: userId,
        previousClaimantUserId: null,
        changedAt: claimedAt,
      });
      const summaryByUser = await this.claimAuthorSummaries([userId]);
      return {
        claimedByUserId: userId,
        isNewlyClaimed: true,
        claimedBy: summaryByUser.get(userId) ?? null,
        claimedAt: claimedAt.toISOString(),
      };
    }
    const current = await this.currentClaimResponse(conversationId);
    return {
      ...current,
      isNewlyClaimed: current.claimedByUserId === userId,
    };
  }

  /**
   * Task 19: take a claimed thread over from the colleague the caller saw
   * holding it (spec 6.5, a visible action that names who did it). One
   * conditional UPDATE guarded on `claimed_by_user_id = :fromUserId`, so a
   * take-over only ever takes the thread from the person the member was
   * shown: when a third colleague claimed it in the meantime, or it was
   * released, no row matches and the caller reads the current state with
   * `isNewlyClaimed: false`, exactly like a lost claim. The same write
   * records `fromUserId` in `claimTakenOverFromUserId` and clears the
   * release columns. `fromUserId` naming the caller changes nothing and
   * reads the current state.
   *
   * Gated exactly like `claim`: `requireParticipant`, then the mailbox
   * lookup, then `assertMayActAs`.
   */
  async takeOver(
    conversationId: string,
    userId: string,
    fromUserId: string,
  ): Promise<TakeOverClaimResponse> {
    await this.core.requireParticipant(conversationId, userId);
    const mailboxIdentityId =
      await this.resolveMailboxIdentityId(conversationId);
    await this.identities.assertMayActAs(userId, mailboxIdentityId);

    if (fromUserId !== userId) {
      const result = await this.conversations
        .createQueryBuilder()
        .update()
        .set({
          claimedByUserId: userId,
          claimedAt: () => 'now()',
          claimReleasedByUserId: null,
          claimReleasedAt: null,
          claimTakenOverFromUserId: fromUserId,
        })
        .where('id = :conversationId', { conversationId })
        .andWhere('claimed_by_user_id = :fromUserId', { fromUserId })
        .returning(['claimedAt'])
        .execute();

      if (result.affected === 1) {
        const claimedAt = returnedTimestamp(result.raw, 'claimed_at');
        this.emitClaimChanged({
          conversationId,
          mailboxIdentityId,
          change: 'taken_over',
          isImplicit: false,
          actorUserId: userId,
          claimedByUserId: userId,
          previousClaimantUserId: fromUserId,
          changedAt: claimedAt,
        });
        const summaryByUser = await this.claimAuthorSummaries([
          userId,
          fromUserId,
        ]);
        return {
          claimedByUserId: userId,
          isNewlyClaimed: true,
          claimedBy: summaryByUser.get(userId) ?? null,
          claimedAt: claimedAt.toISOString(),
          previousClaimant: summaryByUser.get(fromUserId) ?? null,
        };
      }
    }
    const current = await this.currentClaimResponse(conversationId);
    return { ...current, isNewlyClaimed: false, previousClaimant: null };
  }

  /**
   * Release a claim so the thread reads unclaimed again and an idle claim
   * can never lock the mailbox for good. Any staff member of the mailbox may
   * release it, whether or not they are the current claimant: the same
   * roster that may take an unclaimed thread may also simply release a
   * colleague's claim. Gated the same two-step way `claim` is:
   * `requireParticipant` first, then `assertMayActAs`, so a caller with no
   * relationship to the conversation and a caller with a seat but no mailbox
   * standing both learn only "you cannot do this", and nothing about whether
   * a claim, or the conversation itself, exists. A thread that is already
   * unclaimed is left exactly as it is.
   *
   * Task 19: the release records who did it (spec 4.3). It reads the current
   * claimant, then runs exactly one UPDATE guarded on that claimant, which
   * clears the claim, records the caller and the instant in the release
   * columns, and clears `claimTakenOverFromUserId`. No row matching means
   * the claim changed under the caller (a colleague took it over, say), so
   * it re-reads and stops there with no second write: the newer claim
   * stands, and the caller reads who holds the thread now. A release that
   * changed the row emits `CONVERSATION_CLAIM_CHANGED`.
   *
   * Returns the claim as it stands afterwards: `isReleased` is true only
   * when this call's write released it, and `claimedByUserId` names whoever
   * holds the thread when it lost the race. `isNewlyClaimed` is always
   * false.
   */
  async release(
    conversationId: string,
    userId: string,
  ): Promise<ReleaseClaimResponse> {
    await this.core.requireParticipant(conversationId, userId);
    const mailboxIdentityId =
      await this.resolveMailboxIdentityId(conversationId);
    await this.identities.assertMayActAs(userId, mailboxIdentityId);

    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
    });
    const observedClaimantUserId = conversation?.claimedByUserId ?? null;
    if (observedClaimantUserId !== null) {
      const result = await this.conversations
        .createQueryBuilder()
        .update()
        .set({
          claimedByUserId: null,
          claimedAt: null,
          claimReleasedByUserId: userId,
          claimReleasedAt: () => 'now()',
          claimTakenOverFromUserId: null,
        })
        .where('id = :conversationId', { conversationId })
        .andWhere('claimed_by_user_id = :observedClaimantUserId', {
          observedClaimantUserId,
        })
        .returning(['claimReleasedAt'])
        .execute();
      if (result.affected === 1) {
        this.emitClaimChanged({
          conversationId,
          mailboxIdentityId,
          change: 'released',
          isImplicit: false,
          actorUserId: userId,
          claimedByUserId: null,
          previousClaimantUserId: observedClaimantUserId,
          changedAt: returnedTimestamp(result.raw, 'claim_released_at'),
        });
        return {
          claimedByUserId: null,
          isNewlyClaimed: false,
          claimedBy: null,
          claimedAt: null,
          isReleased: true,
        };
      }
    }
    const current = await this.currentClaimResponse(conversationId);
    return { ...current, isNewlyClaimed: false, isReleased: false };
  }

  /**
   * Task 19: the claim as it stands now, read back after a write that
   * changed nothing (a lost claim, a lost or empty take-over). An unclaimed
   * thread reads `claimedByUserId: null`. `isNewlyClaimed` is the caller's
   * to decide.
   */
  private async currentClaimResponse(
    conversationId: string,
  ): Promise<ClaimResponse> {
    const current = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!current) {
      throw new NotFoundException('Conversation not found');
    }
    const claimedByUserId = current.claimedByUserId ?? null;
    const summaryByUser = claimedByUserId
      ? await this.claimAuthorSummaries([claimedByUserId])
      : new Map<string, AuthorSummary | null>();
    return {
      claimedByUserId,
      isNewlyClaimed: false,
      claimedBy: claimedByUserId
        ? (summaryByUser.get(claimedByUserId) ?? null)
        : null,
      claimedAt: claimedByUserId
        ? (current.claimedAt?.toISOString() ?? null)
        : null,
    };
  }

  /**
   * Task 19: author summaries for the people a claim response names, in one
   * profile query, rendered with `toAuthorSummary` exactly as the
   * conversation read renders `claimedBy` for staff.
   */
  private async claimAuthorSummaries(
    userIds: string[],
  ): Promise<Map<string, AuthorSummary | null>> {
    const profiles = await this.profiles.find({
      where: { userId: In([...new Set(userIds)]) },
    });
    const profileByUser = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    return new Map(
      userIds.map((claimUserId) => [
        claimUserId,
        toAuthorSummary(profileByUser.get(claimUserId)),
      ]),
    );
  }

  /**
   * Task 19: `CONVERSATION_CLAIM_CHANGED`, emitted after a claim write that
   * changed the row has committed. Best-effort: the write already stands,
   * so a listener that throws is logged and never fails the request.
   */
  private emitClaimChanged(event: ConversationClaimChangedEvent): void {
    try {
      this.eventEmitter.emit(CONVERSATION_CLAIM_CHANGED, event);
    } catch (error) {
      claimRelayLogger.error(
        `Failed to relay a claim change: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Stricter join gate for a LIVE socket room (`ChatGateway.handleJoin`) than
   * plain participation: also refuses a participant who
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
      // Task 13c: the same seat rule as the inbox and the send-time gate.
      // On a business mailbox thread only a STAFF member blocked either way
      // with the customer is refused (fix round 1); the customer and every
      // other colleague join as before. Task 13g: that rule is decided by
      // `isSeatExcludedFromMailbox`, the helper the inbox composes, so any
      // extension of the shared rule reaches the live room too. Task 14: it
      // refuses the customer and every staff member once the customer has
      // blocked the business.
      const { threadSeats, otherSeats } = await this.core.loadDirectThreadSeats(
        conversationId,
        participant,
      );
      if (threadSeats.mailboxIdentityId) {
        const [blockedUserIds, identityBlockKeys] = await Promise.all([
          this.blockFilter.blockedUserIds(
            userId,
            otherSeats.map((seat) => seat.userId),
          ),
          loadMailboxIdentityBlockKeys(
            mailboxIdentityBlockCandidates(participant, threadSeats),
            this.blockFilter,
          ),
        ]);
        return !isSeatExcludedFromMailbox(
          participant,
          threadSeats,
          blockedUserIds,
          identityBlockKeys,
        );
      }
      // An ordinary DM checks every other seat (it has exactly one).
      for (const other of otherSeats) {
        if (await this.blockFilter.isBlockedEitherWay(userId, other.userId)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Ids of every DIRECT, non-official conversation the two members share.
   *
   * Backs the live-room eviction a block triggers (`ChatGateway`'s
   * `MEMBER_BLOCKED` handler): a block severs the pair for BOTH directions, and
   * `canJoinConversationLive` already refuses a fresh join from either side, so
   * the sockets already inside the room have to be pushed out of it. Group and
   * official threads are excluded for the same reason they are excluded from
   * the block gate in `canJoinConversationLive`/`sendMessage`: a block between
   * two members of a group does not dissolve the group, and nobody is blocked
   * out of the platform's own official thread.
   *
   * Returns ids only (never conversation rows) — the caller needs socket-room
   * names, nothing more.
   */
  async directConversationIdsBetween(
    userId: string,
    otherUserId: string,
  ): Promise<string[]> {
    const rows = await this.participants
      .createQueryBuilder('p')
      .select('p.conversation_id', 'conversationId')
      .innerJoin(Conversation, 'c', 'c.id = p.conversation_id')
      .innerJoin(
        ConversationParticipant,
        'other',
        'other.conversation_id = p.conversation_id AND other.user_id = :otherUserId',
        { otherUserId },
      )
      .where('p.user_id = :userId', { userId })
      .andWhere('c.kind != :group', { group: ConversationKind.Group })
      .andWhere('c.is_official = false')
      // Task 13c: a business mailbox thread is excluded. A block there
      // removes only the blocked staff member's own access, so evicting both
      // of the pair, or voiding the thread's `openedAt`, would take the
      // thread from the customer too. `ChatGateway.handleMemberBlocked`
      // evicts that staff member alone (Task 13e).
      .andWhere(`NOT ${mailboxThreadPredicate('p.conversation_id')}`)
      .getRawMany<{ conversationId: string }>();
    return [...new Set(rows.map((row) => row.conversationId))];
  }

  /**
   * PRD-340: "a block either way stays a hard stop and must void the opened
   * state." A block already refuses every send outright (the hard stop lives
   * in `MessagesService.sendMessage`'s block check, ahead of the reply gate).
   * This handles what happens instead if they ever unblock without
   * reconnecting: without clearing `openedAt` here, the
   * thread would silently resume as fully open the moment the block lifts.
   * Resetting it means the non-initiator has to earn it again with a fresh
   * reply, same as a thread that was never opened. Reuses
   * `directConversationIdsBetween` rather than a second lookup query.
   *
   * PRD-363: the voided value is stashed in `openedAtBeforeBlock` so an
   * unblock can put it back ({@link handleMemberUnblocked}). `COALESCE` keeps
   * an earlier stash when this is a second block (the other member blocking
   * too, or an idempotent re-block) and `openedAt` is already NULL.
   */
  @OnEvent(MEMBER_BLOCKED)
  async handleMemberBlocked(payload: MemberBlockedEvent): Promise<void> {
    const conversationIds = await this.directConversationIdsBetween(
      payload.blockerId,
      payload.blockedId,
    );
    if (conversationIds.length === 0) return;
    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({
        openedAtBeforeBlock: () =>
          'COALESCE("opened_at", "opened_at_before_block")',
        openedAt: null,
      })
      .where('"id" IN (:...conversationIds)', { conversationIds })
      .execute();
  }

  /**
   * PRD-363: undo what {@link handleMemberBlocked} voided. Runs after the
   * unblock committed. If a block still stands in the other direction the
   * stash is left alone (every send is refused anyway) and is restored when
   * that last block lifts. Only threads with something stashed are touched,
   * and a thread re-opened in the meantime keeps its newer `openedAt`.
   */
  @OnEvent(MEMBER_UNBLOCKED)
  async handleMemberUnblocked(payload: MemberUnblockedEvent): Promise<void> {
    const { unblockerId, unblockedId } = payload;
    if (await this.blockFilter.isBlockedEitherWay(unblockerId, unblockedId)) {
      return;
    }
    const conversationIds = await this.directConversationIdsBetween(
      unblockerId,
      unblockedId,
    );
    if (conversationIds.length === 0) return;
    await this.conversations
      .createQueryBuilder()
      .update(Conversation)
      .set({
        openedAt: () => 'COALESCE("opened_at", "opened_at_before_block")',
        openedAtBeforeBlock: null,
      })
      .where('"id" IN (:...conversationIds)', { conversationIds })
      .andWhere('"opened_at_before_block" IS NOT NULL')
      .execute();
  }

  /**
   * `POST /conversations` — create-or-return the DM with `recipientHandle`
   * (this backend's `slug`). Thin wrapper over the same
   * `getOrCreateConversation` helper `MessageRequestsService.messageRequest`
   * uses, minus the required first message: opening a thread from a profile
   * shouldn't force the caller to have already typed something, and this is
   * intentionally idempotent (repeat calls return the same conversation). A
   * block either way is a hard stop: a blocked user cannot even open a thread.
   *
   * PRD-343: a fresh thread between two members who are NOT accepted
   * connections is refused (403). Cold first contact must go through the
   * message-request / enquiry flow instead, which seeds an explicit
   * `initiatorUserId` this endpoint does not. An EXISTING thread is still
   * returned (never re-403s) once the reply gate reads `"open"` for this
   * caller: the one-tap-reply recipient of a cold enquiry, or either side
   * once the thread was opened (PRD-340). So this stays the same idempotent
   * "open (or reuse)" call for a thread that already welcomes the caller.
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

    const isConnected = await this.connectionsService.areConnected(
      userId,
      recipient.userId,
    );
    if (!isConnected) {
      const existing = await this.conversations.findOne({
        where: {
          pairKey: await this.core.resolveProfilePairKey(
            userId,
            recipient.userId,
          ),
        },
      });
      const gate = existing
        ? this.replyGateFor(existing, userId, isConnected)
        : 'needsConnection';
      if (gate !== 'open') {
        throw new ForbiddenException({
          statusCode: 403,
          message:
            'You can only start a conversation with accepted connections',
          code: CONVERSATION_REQUIRES_CONNECTION_CODE,
        });
      }
    }

    const { conversation } = await this.core.getOrCreateConversation(
      userId,
      recipient.userId,
    );
    return this.toConversationResponse(conversation, userId, recipient.userId);
  }

  /**
   * PRD-340: the one-tap-reply state of a non-connected DIRECT, non-official
   * DM, from `viewerUserId`'s point of view. Connected pairs and group/
   * official threads never reach the interesting branches. Call with
   * `isConnected: true` or skip this entirely; see `ConversationResponse
   * .replyGate` for the three outcomes' meaning.
   */
  private replyGateFor(
    convo: Pick<Conversation, 'initiatorUserId' | 'openedAt'>,
    viewerUserId: string,
    isConnected: boolean,
  ): 'open' | 'awaitingTheirReply' | 'needsConnection' {
    if (isConnected || convo.openedAt) {
      return 'open';
    }
    if (!convo.initiatorUserId) {
      // No known initiator. This is the SAFE default and covers two real
      // cases: a DIRECT, non-official thread with zero messages ever sent
      // (the backfill migration only sets `initiator_user_id` for a thread
      // that has at least one), and, just as importantly, a formerly
      // connected pair's ordinary DM after they disconnect. Neither the
      // backfill nor `getOrCreateConversation` ever infers "cold contact"
      // from a connected pair's message history, so that history earns
      // neither side anything here. With no explicit initiator, nobody has
      // anything to reply to yet: fall back to the platform's original rule
      // (connect first).
      return 'needsConnection';
    }
    if (convo.initiatorUserId === viewerUserId) {
      return 'awaitingTheirReply';
    }
    // The viewer did NOT initiate: their first ordinary send is what flips
    // `openedAt` (see `MessagesService.sendMessage`'s connection-gate block).
    return 'open';
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
      areConnected,
      acceptedSinceByCounterpart,
      privacyByUser,
    ] = await Promise.all([
      this.profiles.find({ where: { userId: In([userId, otherUserId]) } }),
      this.core.lastMessagesByConversation([convo.id], userId),
      this.core.unreadCountsByConversation([convo.id], userId),
      this.participants.findOne({
        where: { conversationId: convo.id, userId: otherUserId },
      }),
      this.participants.findOne({
        where: { conversationId: convo.id, userId },
      }),
      // `replyRequiresConnection`/`replyGate` (PRD-220/PRD-340): see
      // `listConversations`' matching comment for the exact gate this mirrors.
      this.connectionsService.areConnected(userId, otherUserId),
      // DES-225: `connectedSince`, one lookup for this single DM. Skipped for
      // an official thread, which has no counterpart to have connected with.
      convo.isOfficial
        ? Promise.resolve(new Map<string, Date>())
        : this.connectionsService.acceptedSinceByCounterpart(userId, [
            otherUserId,
          ]),
      // PRD-364: reciprocal read-receipt sharing — see `listConversations`'
      // matching comment.
      this.preferencesService.getMessagingPrivacyForUsers([
        userId,
        otherUserId,
      ]),
    ]);
    const viewerSharesReadReceipts =
      privacyByUser.get(userId)?.shareReadReceipts ?? true;
    const otherSharesReadReceipts =
      privacyByUser.get(otherUserId)?.shareReadReceipts ?? true;
    const replyGate = convo.isOfficial
      ? 'open'
      : this.replyGateFor(convo, userId, areConnected);
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
            userId,
            undefined,
            callerParticipantRow?.identityId,
          )
        : null,
      unreadCount: unreadByConvo.get(convo.id) ?? 0,
      updatedAt: (
        clearedLastMessage?.createdAt ?? convo.createdAt
      ).toISOString(),
      // PRD-364: reciprocal — see `listConversations`'s matching field.
      otherLastReadAt:
        viewerSharesReadReceipts && otherSharesReadReceipts
          ? (otherParticipantRow?.lastReadAt?.toISOString() ?? null)
          : null,
      // PRD-351: the same reciprocal gate as `otherLastReadAt` above, applied
      // to the real read INSTANT instead of the watermark. See
      // `listConversations`'s matching field, which this mirrors exactly.
      otherLastReadInstant:
        viewerSharesReadReceipts && otherSharesReadReceipts
          ? (otherParticipantRow?.lastReadInstant?.toISOString() ?? null)
          : null,
      myLastReadAt: callerParticipantRow?.lastReadAt?.toISOString() ?? null,
      otherDeliveredAt: otherParticipantRow?.deliveredAt?.toISOString() ?? null,
      otherParticipantId: otherParticipantRow?.userId ?? null,
      replyRequiresConnection: !convo.isOfficial && replyGate !== 'open',
      replyGate,
      connectedSince:
        acceptedSinceByCounterpart.get(otherUserId)?.toISOString() ?? null,
      // DM: the group-only fields carry their empty defaults so the DTO shape is
      // uniform. The client's DM path never reads them.
      kind: 'direct',
      title: null,
      avatarUrl: null,
      memberCount: 0,
      members: [],
      // ENG-253: a DM has no group roster to preview, mirrors `members: []`
      // immediately above.
      memberPreview: [],
      description: null,
      dissolvedAt: null,
      leftReason: null,
      inviteToken: null,
      pendingInvites: [],
    };
  }
}
