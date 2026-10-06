import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OfficialMailboxSeatsService } from '../identities/official-mailbox-seats.service';
import { InjectRepository } from '@nestjs/typeorm';
import { maxLength } from 'class-validator';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { DeleteMessageDto } from './dto/delete-message.dto';
import {
  MESSAGE_DELETE_EVIDENCE_HOLD_DAYS,
  messageAttachmentStorageKeys,
} from './message-evidence-hold';
import {
  MESSAGE_DELETED_BY_STAFF_AUDIT_ACTION,
  REPORT_SUBJECT_MISMATCH_CODE,
  staffMessageDeletionAuditNote,
} from './staff-message-deletion';
import { ACCOUNT_RESTRICTED_CODE } from '../auth/guards/not-restricted.guard';
import { toImageUrl } from '../common/image-url';
import { escapeLikeTerm } from '../common/like-escape';
import {
  countCharacters,
  truncateCharacters,
  widenToCodePointBoundaries,
} from '../common/text-characters';
import {
  CAPTIONED_MESSAGE_KINDS,
  messageMentionText,
} from '../common/mentions';
import { ConnectionsService } from '../connections/connections.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import {
  foldedHaystack,
  foldedSearchTerm,
  foldedTextExpression,
} from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import {
  AttachmentInput,
  DocumentAttachment,
  GifAttachment,
  isStickerAttachment,
  Message,
  MessageKind,
  StickerAttachment,
} from './entities/message.entity';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
  EXACT_CREATED_AT_SELECT,
} from './message-history-cursor';
import {
  messageKindToResponseKind,
  MessageHistoryPage,
  MessageResponse,
  MessageSearchConversationGroup,
  MessageSearchResponse,
  resolveAttachment,
  toMessageView,
} from './message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import {
  DEFAULT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_LIMIT,
  MAX_SEARCH_LIMIT,
  EDIT_WINDOW_MS,
  CAPTION_EDIT_MESSAGE_KINDS,
  MAX_ATTACHMENT_CAPTION_LENGTH,
  UNEDITABLE_MESSAGE_KINDS,
} from './messaging.constants';
import {
  MESSAGE_DELETED,
  MESSAGE_UPDATED,
  MessageDeletedEvent,
  MessageUpdatedEvent,
} from './messaging.events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { seatExcludedFromMailboxPredicate } from './mailbox-seats';
import {
  MessagingCoreService,
  type PageConversationHint,
} from './messaging-core.service';
import { StorageService } from '../storage/storage.service';

/**
 * ENG-241: a system pill (`MessageKind.System`, e.g. "Ana made Cy an admin")
 * is an audit row, not a message anyone authored. Its `senderId` is set to
 * the actor purely so it renders in the room, but the actor is not its
 * "author" for edit/delete purposes. Refusing both here (rather than relying
 * on `canEdit`/`canDelete` in `messaging-core.service.ts`, which is a display
 * hint only) keeps an admin from tombstoning or rewriting the shared timeline
 * audit trail their own action produced. Mirrors
 * `CONVERSATION_REQUIRES_CONNECTION_CODE`'s coded-exception convention
 * (`conversations.service.ts`).
 */
export const SYSTEM_MESSAGE_IMMUTABLE_CODE = 'SYSTEM_MESSAGE_IMMUTABLE';

/**
 * ENG-405: a sticker message carries no text its author wrote that an edit
 * could change (its `body` is empty and its label comes from the catalogue).
 * `canEdit` already withholds Edit from it; this coded 403 is the endpoint's
 * own refusal for a client that offers the action anyway. Same coded-exception
 * convention as `SYSTEM_MESSAGE_IMMUTABLE_CODE` above.
 */
export const MESSAGE_KIND_NOT_EDITABLE_CODE = 'MESSAGE_KIND_NOT_EDITABLE';

/**
 * PRD-372: the refusal for a send into an official thread from a seat that
 * may not write there.
 *
 * The member the thread belongs to MAY reply: their reply seats the
 * QueerPulse Team's staff first (`OfficialMailboxSeatsService`), so it lands
 * in the staff mailbox and is answered there. Before that mailbox existed the
 * reply fanned out to nobody, which is why this refusal was introduced. Staff
 * reply from their `official` seat, as the QueerPulse Team. Any other seat (a
 * staff seat ended when its holder lost the role) is refused with this code.
 *
 * The platform's OWN posting path is not affected: `OfficialConversationsService`
 * and `OfficialBroadcastsService` both write through
 * `MessagingCoreService.postMessage`, below this method.
 */
export const OFFICIAL_THREAD_READ_ONLY_CODE = 'OFFICIAL_THREAD_READ_ONLY';

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
    return countCharacters(body) > LEAD + TRAIL
      ? `${truncateCharacters(body, LEAD + TRAIL).trimEnd()}…`
      : body;
  }
  // The window's edges are code-unit offsets, so each is widened off the
  // middle of an emoji's surrogate pair before the cut.
  const { start, end } = widenToCodePointBoundaries(
    body,
    Math.max(0, index - LEAD),
    Math.min(body.length, index + query.length + TRAIL),
  );
  const core = body.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${core}${end < body.length ? '…' : ''}`;
}

/**
 * ENG-405: the text a search hit's snippet is cut from, matching what
 * `searchMessages` matched on. A photo, document or GIF contributes its
 * caption (its `body` is only the "Photo"/"Document"/"GIF" fallback, which
 * search skips). A sticker contributes '' and is never matched: it has no
 * caption, and search skips its body along with the captioned kinds', since
 * a sticker edited before ENG-405 still holds the edit's text there. Every
 * other kind contributes its body.
 */
export function searchHitText(
  message: Pick<Message, 'kind' | 'body' | 'attachment'>,
): string {
  if (!CAPTIONED_MESSAGE_KINDS.includes(message.kind)) {
    return message.body;
  }
  return messageMentionText(message);
}

/** Query options for `getMessages`; mirrors `GetMessagesQuery`. */
export interface GetMessagesOptions {
  before?: string;
  beforeId?: string;
  after?: string;
  afterId?: string;
  limit?: number;
  cursor?: string;
  /** PRD-401: centre the page on this message id (see `getMessagesAround`). */
  around?: string;
}

/**
 * PRD-401: a window of thread history centred on one message, in the backward
 * page's envelope. `data` is newest-first like every backward page.
 * `pageInfo.nextCursor`/`hasMore` page OLDER from the window's oldest row
 * (sent back as `cursor`); `newerAfter`/`newerAfterId` are the exact keyset of
 * the window's newest row, sent back as `after`/`afterId` to page NEWER
 * through the forward path until it rejoins the live tail. `hasNewer` is false
 * once the window already reaches the newest visible message.
 */
export interface MessageHistoryWindowPage extends MessageHistoryPage {
  pageInfo: MessageHistoryPage['pageInfo'] & {
    hasNewer: boolean;
    newerAfter: string | null;
    newerAfterId: string | null;
  };
}

/** One history row with its exact microsecond `created_at` text. */
interface ExactHistoryRow {
  message: Message;
  exactCreatedAt: string;
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
  private readonly logger = new Logger(MessagesService.name);

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
    private readonly mentions: MentionNotificationService,
    private readonly storage: StorageService,
    // PRD-372: a member's reply into their official thread seats the
    // QueerPulse Team's staff first; see `sendMessageWithOutcome`.
    private readonly officialMailboxSeats: OfficialMailboxSeatsService,
  ) {}

  /**
   * Thread history. The backward "load older" path (the default) returns a
   * `MessageHistoryPage` envelope so the client can keep paging; the forward
   * reconcile path (`opts.after`) returns a bare array, which is what
   * reconnect history sync merges. `opts.around` (PRD-401) returns a
   * `MessageHistoryWindowPage` centred on one message.
   */
  async getMessages(
    conversationId: string,
    userId: string,
    opts: GetMessagesOptions,
  ): Promise<MessageHistoryPage | MessageResponse[]> {
    const hasKeysetCursor = Boolean(
      opts.before || opts.beforeId || opts.after || opts.afterId || opts.cursor,
    );
    if (opts.around && hasKeysetCursor) {
      throw new BadRequestException(
        '`around` cannot be combined with `before`, `after` or `cursor`',
      );
    }
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // PRD-354: a block does not dissolve a GROUP (unlike a DM, where a block
    // already severs sending and the thread drops out of the blocker's
    // inbox), so a blocked-either-way sender's messages otherwise keep
    // showing to every other member forever. Filtered IN SQL below (never a
    // post-query `.filter()`) so a cursor page never under-fills. One extra
    // lightweight lookup, shared by the backward page, the PRD-401 window
    // and the forward reconnect-sync branch below.
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { kind: true, isGoTogetherChat: true, eventMatchGroupId: true },
    });
    const isGroupConversation = conversation?.kind === ConversationKind.Group;
    // PRD-423: the row just read, handed to `toMessageResponses` so a page
    // learns whether it is a matched Go together chat with no second lookup.
    const pageConversation: PageConversationHint | undefined = conversation
      ? {
          kind: conversation.kind,
          isGoTogetherChat: conversation.isGoTogetherChat ?? false,
          eventMatchGroupId: conversation.eventMatchGroupId ?? null,
        }
      : undefined;
    // PRD-401: jump-to-message for a message older than the loaded pages.
    if (opts.around) {
      return this.getMessagesAround(
        conversationId,
        userId,
        participant,
        opts.around,
        limit,
        pageConversation,
      );
    }
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
        isGroupConversation,
        pageConversation,
      );
    }
    // An explicit `before`/`beforeId` wins; otherwise decode the frontend's
    // opaque `cursor` onto the same (createdAt, id) keyset predicate. A
    // malformed cursor decodes to `null` and is treated as no cursor (first
    // page) rather than rejecting the request. The cursor keeps the exact
    // microsecond timestamp text (see `message-history-cursor.ts`), so it is
    // bound verbatim and never round-tripped through a millisecond JS Date.
    let before = opts.before;
    let beforeId = opts.beforeId;
    if (!before && opts.cursor) {
      const decoded = decodeMessageHistoryCursor(opts.cursor);
      if (decoded) {
        before = decoded.before;
        beforeId = decoded.beforeId;
      }
    }
    const qb = this.visibleHistoryQuery(
      conversationId,
      userId,
      participant.clearedAt,
      participant.leftAt,
      isGroupConversation,
    );
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
    //
    // `limit + 1` rows decide `hasMore` exactly without a count query; the
    // extra row is trimmed. The exact created_at text rides along as a raw
    // column so the next cursor is lossless (the entity's `Date` is not).
    const { entities, raw } = await qb
      .withDeleted()
      .addSelect(EXACT_CREATED_AT_SELECT, 'cursor_created_at')
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1)
      .getRawAndEntities<{ m_id: string; cursor_created_at: string }>();
    const hasMore = entities.length > limit;
    const pageRows = hasMore ? entities.slice(0, limit) : entities;
    const oldestRow = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && oldestRow) {
      // There is no join, so every entity has its own raw row. The millisecond
      // fallback only guards a driver surprise; it can skip same-millisecond
      // rows, which is why it is never the primary source.
      const oldestRawRow = raw.find((rawRow) => rawRow.m_id === oldestRow.id);
      const exactCreatedAt =
        oldestRawRow?.cursor_created_at ?? oldestRow.createdAt.toISOString();
      nextCursor = encodeMessageHistoryCursor(exactCreatedAt, oldestRow.id);
    }
    return {
      data: await this.core.toMessageResponses(
        pageRows,
        userId,
        Boolean(participant.leftAt),
        // ENG-240 hot-path fix: already looked up above for the block filter,
        // so `toMessageResponses` skips its own `conversations.findOne`.
        pageConversation,
      ),
      pageInfo: { nextCursor, hasMore },
    };
  }

  /**
   * Messages strictly newer than the `(after, afterId)` keyset, oldest→newest,
   * capped at `limit`. Backs reconnect history sync: after a socket drop (which
   * buffers nothing) the client re-fetches the gap since its last known message
   * and merges it, deduping by id. Honours the caller's `clearedAt` floor AND
   * `leftAt` ceiling just like the backward path, so a cleared conversation
   * never resurrects history and a left/removed group member can't use
   * reconnect-sync to read past their departure. `isGroupConversation`
   * (PRD-354) mirrors the same block filter `getMessages` applies to its
   * backward page, so reconnect sync can't resurface a blocked-either-way
   * group member's messages either.
   */
  private async getMessagesSince(
    conversationId: string,
    userId: string,
    clearedAt: Date | null,
    leftAt: Date | null,
    after: string,
    afterId: string | undefined,
    limit: number,
    isGroupConversation: boolean,
    // PRD-423: the row `getMessages` read, so the page needs no lookup.
    pageConversation?: PageConversationHint,
  ): Promise<MessageResponse[]> {
    // Every visibility rule of the backward page (floor, ceiling, hides,
    // PRD-354 group block filter), so reconnect sync can never resurrect a
    // message the thread itself hides.
    const qb = this.visibleHistoryQuery(
      conversationId,
      userId,
      clearedAt,
      leftAt,
      isGroupConversation,
    );
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
    return this.core.toMessageResponses(
      rows,
      userId,
      Boolean(leftAt),
      // ENG-240 hot-path fix: the caller (`getMessages`) already resolved
      // this; `isGroupConversation` carries every bit of it `toMessageResponses`
      // actually needs (Group vs not), so this skips its own `conversations`
      // lookup too.
      pageConversation ??
        (isGroupConversation
          ? ConversationKind.Group
          : ConversationKind.Direct),
    );
  }

  /**
   * The ONE definition of which rows of a conversation's history exist for
   * `userId`, shared by the backward page, reconnect sync and the PRD-401
   * window so the three can never drift:
   *  - the `clearedAt` floor: messages at or before the caller's clear point
   *    don't exist for them (WhatsApp "cleared" semantics). A mailbox staff
   *    seat's privacy floor is written into `clearedAt` too
   *    (`ConversationParticipant.historyFloorAt`), so this also hides
   *    pre-hire history;
   *  - the `leftAt` ceiling (P0 hardening): a removed or departed group
   *    member reads only what was posted while they belonged;
   *  - PRD-227 "delete for me": a message THIS viewer hid never exists for
   *    them again, while every other participant's copy is untouched;
   *  - PRD-354, groups only: a blocked-either-way sender's messages are
   *    filtered IN SQL (so a keyset page never under-fills). `unless` keeps a
   *    group's own system pills visible whoever their actor is: a pill
   *    reports what happened in the group, and hiding it would leave silent
   *    gaps in the roster history.
   * Moderator takedowns are deliberately left IN: `toMessageResponses`
   * renders them as tombstones that keep their slot in the timeline.
   */
  private visibleHistoryQuery(
    conversationId: string,
    userId: string,
    clearedAt: Date | null,
    leftAt: Date | null,
    isGroupConversation: boolean,
  ): SelectQueryBuilder<Message> {
    const qb = this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :id', { id: conversationId });
    if (clearedAt) {
      qb.andWhere('m.created_at > :clearedAt', {
        clearedAt: clearedAt.toISOString(),
      });
    }
    if (leftAt) {
      qb.andWhere('m.created_at <= :leftAt', {
        leftAt: leftAt.toISOString(),
      });
    }
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "message_hides" "mh"
        WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :hidingUserId
      )`,
      { hidingUserId: userId },
    );
    if (isGroupConversation) {
      this.blockFilter.excludeBlocked(qb, userId, '"m"."sender_id"', {
        unless: `"m"."kind" = 'system'`,
      });
    }
    return qb;
  }

  /**
   * Runs a visible-history query with soft-deleted rows included (they render
   * as tombstones) and pairs every entity with its exact microsecond
   * `created_at` text, which is what every keyset boundary binds.
   */
  private async loadExactHistoryRows(
    qb: SelectQueryBuilder<Message>,
  ): Promise<ExactHistoryRow[]> {
    const { entities, raw } = await qb
      .withDeleted()
      .addSelect(EXACT_CREATED_AT_SELECT, 'cursor_created_at')
      .getRawAndEntities<{ m_id: string; cursor_created_at: string }>();
    const exactById = new Map(
      raw.map((rawRow) => [rawRow.m_id, rawRow.cursor_created_at]),
    );
    return entities.map((message) => ({
      message,
      exactCreatedAt:
        exactById.get(message.id) ?? message.createdAt.toISOString(),
    }));
  }

  /**
   * PRD-401: a window of history centred on `aroundId`, so jump-to-message
   * reaches a message however far back it is in one request. The target is
   * first looked up through the SAME visibility rules as every history page
   * (`visibleHistoryQuery`); a message outside what this caller may see, or
   * one that is not in this conversation at all, answers the same 404, so the
   * response never tells the two apart. Around it: up to half the page limit
   * of older rows and the rest newer, each fetched with one extra row to
   * decide `hasMore`/`hasNewer` exactly, ordered on the same
   * `(created_at, id)` keyset the backward and forward paths use, so the
   * window's cursors hand straight over to them.
   */
  private async getMessagesAround(
    conversationId: string,
    userId: string,
    participant: ConversationParticipant,
    aroundId: string,
    limit: number,
    // PRD-423: the row `getMessages` read (kind and the Go together flags).
    pageConversation: PageConversationHint | undefined,
  ): Promise<MessageHistoryWindowPage> {
    const isGroupConversation =
      pageConversation?.kind === ConversationKind.Group;
    const visibleQuery = () =>
      this.visibleHistoryQuery(
        conversationId,
        userId,
        participant.clearedAt,
        participant.leftAt,
        isGroupConversation,
      );
    const [target] = await this.loadExactHistoryRows(
      visibleQuery().andWhere('m.id = :aroundId', { aroundId }).take(1),
    );
    if (!target) {
      throw new NotFoundException('Message not found');
    }
    const olderCount = Math.floor((limit - 1) / 2);
    const newerCount = limit - 1 - olderCount;
    const anchor = {
      anchorCreatedAt: target.exactCreatedAt,
      anchorId: target.message.id,
    };
    const [olderRows, newerRows] = await Promise.all([
      this.loadExactHistoryRows(
        visibleQuery()
          .andWhere(
            '(m.created_at, m.id) < (:anchorCreatedAt::timestamptz, :anchorId::uuid)',
            anchor,
          )
          .orderBy('m.created_at', 'DESC')
          .addOrderBy('m.id', 'DESC')
          .take(olderCount + 1),
      ),
      this.loadExactHistoryRows(
        visibleQuery()
          .andWhere(
            '(m.created_at, m.id) > (:anchorCreatedAt::timestamptz, :anchorId::uuid)',
            anchor,
          )
          .orderBy('m.created_at', 'ASC')
          .addOrderBy('m.id', 'ASC')
          .take(newerCount + 1),
      ),
    ]);
    const hasMore = olderRows.length > olderCount;
    const hasNewer = newerRows.length > newerCount;
    const olderInWindow = olderRows.slice(0, olderCount);
    const newerInWindow = newerRows.slice(0, newerCount);
    // Newest-first, the order every backward page uses.
    const windowRows = [...newerInWindow.reverse(), target, ...olderInWindow];
    const oldestRow = windowRows[windowRows.length - 1];
    const newestRow = windowRows[0];
    return {
      data: await this.core.toMessageResponses(
        windowRows.map((row) => row.message),
        userId,
        Boolean(participant.leftAt),
        pageConversation,
      ),
      pageInfo: {
        nextCursor:
          hasMore && oldestRow
            ? encodeMessageHistoryCursor(
                oldestRow.exactCreatedAt,
                oldestRow.message.id,
              )
            : null,
        hasMore,
        hasNewer,
        newerAfter: hasNewer && newestRow ? newestRow.exactCreatedAt : null,
        newerAfterId: hasNewer && newestRow ? newestRow.message.id : null,
      },
    };
  }

  /**
   * Cross-conversation full-text-ish search over the caller's own messages.
   *
   * Server-authoritative on every axis the spec requires:
   *  - **Participation:** an `EXISTS` subquery against the caller's own
   *    participant row (`p.user_id = :userId`) means only messages in
   *    conversations the caller belongs to are ever considered, there is no
   *    way to widen it from the request. The `EXISTS` is deliberate here
   *    (ENG-252): a join alongside `.take()` makes TypeORM engage its
   *    distinct-id two-query pagination pass (it treats ANY joined builder
   *    with a limit as row-multiplying, whether or not it actually is), which
   *    means every debounced keystroke ran two round-trips instead of one. The
   *    `EXISTS` subquery scopes identically, `conversation_participants` is
   *    `UNIQUE(conversation_id, user_id)`, so at most one row can ever match,
   *    without TypeORM seeing a join at all, so `.take()` compiles straight to
   *    a single `SELECT … LIMIT`.
   *  - **`clearedAt` flooring:** the same subquery's row carries the caller's
   *    clear point; `(p.cleared_at IS NULL OR m.created_at > p.cleared_at)`
   *    hides anything at-or-before it, identical to `getMessages`' history
   *    floor, so a "deleted for me" thread never resurfaces through search.
   *  - **`leftAt` ceiling:** the mirror of the floor above, a member removed
   *    from (or who left) a group cannot probe terms to read
   *    `buildSearchSnippet` windows of messages posted after their departure.
   *  - **Moderation takedowns / PRD-227 hides:** `NOT EXISTS` against
   *    `content_moderation` and `message_hides` respectively, unchanged.
   *  - **Tombstone exclusion:** no `.withDeleted()`, so the `@DeleteDateColumn`
   *    default filter drops soft-deleted rows — a deleted body is never a hit.
   *
   * Matching is an accent- and case-folded substring match: the same
   * `foldedHaystack`/`foldedSearchTerm` vocabulary (`search-text.ts`,
   * `translate(lower(...))` under the hood) that `MessageAnnotationsService
   * .listStarredMessages` already uses, so a member typing "cafe" finds a
   * body that reads "café" here too, on a Portuguese-language platform where
   * that gap was a real miss. The term's LIKE metacharacters are escaped and
   * the pattern is passed as a bound parameter (injection-safe); folding both
   * sides with the same expression makes the comparison case-insensitive too,
   * so `ILIKE` is no longer needed. This is a deliberate folded-substring MVP
   * with NO new index/migration: a single member's DM corpus is small and
   * already narrowed to their conversations by the participation `EXISTS`
   * (which rides the existing `messages (conversation_id, …)` index), so a
   * scan of that subset is cheap. Measured directly (`EXPLAIN ANALYZE`) at a
   * realistic heaviest-member scale (6,000 of one member's own messages
   * inside 18,000 total), the plan stays the same nested loop over that
   * index the pre-fold `ILIKE` used, at roughly 35ms for the worst term
   * shape, comfortably inside a 100ms search-as-you-type budget; folding
   * costs real per-row time (`translate()`/`lower()` on every candidate row
   * the nested loop visits) but never forces a sequential scan. A `pg_trgm`
   * index measured SLOWER than the plain `ILIKE` baseline on the common-term
   * case at this same scale, so none is added here. A weighted `tsvector`
   * GIN index is the right upgrade if per-member volume ever grows enough to
   * change that measurement, added then as a migration after `1785000800000`.
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
    mailboxIdentityId?: string,
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
    // `translate()`/`lower()` only ever touch the accented-letter and case
    // pairs `foldedTextExpression` lists; `\`, `%`, and `_` sit outside that
    // set, so `escapeLikeTerm`'s escaping survives folding intact and the
    // LIKE pattern still means what `escapeLikeTerm` built it to mean. Both
    // sides are folded with the SAME expression, so this already gives a
    // case-insensitive comparison without `ILIKE`. `ESCAPE '\'` pins the
    // escape character explicitly, matching `listStarredMessages`' own
    // folded `LIKE` comparison.
    const foldedTerm = foldedSearchTerm('pattern');
    // Task 24: `?as=` narrows the participation `EXISTS` below to the
    // caller's own seat that speaks for that mailbox. It sits inside the
    // subquery, so `.take()` stays a plain `LIMIT` (ENG-252). The caller
    // (`MessagingService.searchMessages`) authorizes the mailbox first.
    const hasMailboxFilter = mailboxIdentityId !== undefined;
    const mailboxSeatPredicate = hasMailboxFilter
      ? 'AND "p"."identity_id" = :mailboxIdentityId'
      : '';
    const searchQuery = this.messages
      .createQueryBuilder('m')
      // ENG-405: a photo, document or GIF is matched on its caption, the same
      // `attachment ->> 'caption'` match `listStarredMessages` uses. Its
      // `body` is the "Photo"/"Document"/"GIF" fallback, so it is skipped: a
      // search for "photo" or "gif" would otherwise match every photo or GIF
      // ever sent. A sticker's body is skipped too (`CAPTIONED_MESSAGE_KINDS`
      // lists it): a sticker edited before ENG-405 still holds the edit's
      // text there, which would otherwise surface as a hit with a blank
      // snippet. Every other kind keeps its body match. `searchHitText`
      // cuts the snippet from the same field.
      .where(
        `(
          (m.kind NOT IN (:...captionOnlySearchKinds)
            AND ${foldedHaystack('m', ['body'])} LIKE ${foldedTerm} ESCAPE '\\')
          OR ${foldedTextExpression("coalesce(m.attachment ->> 'caption', '')")} LIKE ${foldedTerm} ESCAPE '\\'
        )`,
        {
          pattern,
          captionOnlySearchKinds: [...CAPTIONED_MESSAGE_KINDS],
        },
      )
      // Participation gate + clearedAt floor + leftAt ceiling, all in one
      // non-row-multiplying `EXISTS` (see this method's own doc for why an
      // `EXISTS` replaces the old `innerJoin` here, ENG-252). Scopes the
      // search to conversations THIS user belongs to; the predicate is not a
      // WHERE the caller could influence, so it can't be widened from the
      // request.
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "conversation_participants" "p"
          WHERE "p"."conversation_id" = m.conversation_id
            AND "p"."user_id" = :userId
            AND (p.cleared_at IS NULL OR m.created_at > p.cleared_at)
            AND (p.left_at IS NULL OR m.created_at <= p.left_at)
            ${mailboxSeatPredicate}
        )`,
        hasMailboxFilter ? { userId, mailboxIdentityId } : { userId },
      )
      // Task 13c fix round 1: a STAFF member blocked either way with a
      // mailbox thread's customer finds nothing from that thread. Task 14a:
      // nor does a staff member who has left the business. Task 14: nor
      // does either side of a thread whose customer blocked the business.
      .andWhere(
        `NOT ${seatExcludedFromMailboxPredicate('m.conversation_id', ':userId')}`,
      )
      // Single-thread scope ("search in this chat", opened from an already-open
      // conversation), additive on top of the participation gate above, so a
      // conversation the caller isn't in still yields zero rows rather than
      // ever widening the search.
      .andWhere(
        conversationId ? 'm.conversation_id = :conversationId' : '1=1',
        conversationId ? { conversationId } : {},
      )
      // Moderator-taken-down messages (hidden OR removed, keyed by the message
      // uuid) never surface as a search hit — the searcher is always an
      // ordinary participant here (never acting as staff), and a tombstoned
      // body is meaningless to match on. In-query NOT EXISTS so the capped page
      // isn't under-filled. `content_moderation.subject_id` is varchar while
      // `m.id` is uuid, hence the `::text` cast.
      .andWhere(notModeratedMessagePredicate('m'), {
        messageSubjectType: MESSAGE_SUBJECT_TYPE,
      })
      // PRD-227 "delete for me": a message THIS searcher hid from their own
      // view must not resurface as a search hit either — mirrors the
      // moderation NOT EXISTS just above, keyed by (message, this userId)
      // instead. `userId` is already bound via the participation EXISTS above.
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "message_hides" "mh"
          WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :userId
        )`,
        { userId },
      );
    // PRD-354: the same group-only sender block filter `getMessages` applies
    // to thread history also applies to search: a group keeps a blocked
    // member's messages searchable forever otherwise. `unless` scopes the
    // filter to GROUP rows only (a raw `EXISTS` against `conversations`, not
    // a join, so `.take()` below still compiles to a plain `LIMIT`, ENG-252):
    // a DM's search hits are unaffected, matching `getMessages`' own DM
    // behaviour (a block severs sending, not history).
    this.blockFilter.excludeBlocked(searchQuery, userId, '"m"."sender_id"', {
      unless: `NOT EXISTS (
          SELECT 1 FROM "conversations" "sbfc"
          WHERE "sbfc"."id" = m.conversation_id AND "sbfc"."kind" = 'group'
        )`,
    });
    const rows = await searchQuery
      // No `.withDeleted()`: the @DeleteDateColumn default filter drops
      // soft-deleted rows, so tombstoned bodies are never returned.
      // No join in this builder any more (ENG-252), so `.take()` compiles to a
      // single `SELECT … ORDER BY … LIMIT`, TypeORM's distinct-id pagination
      // pass only ever triggers when a join is present.
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(cappedLimit)
      .getMany();

    if (!rows.length) {
      return { query, hits: [], conversations: [] };
    }

    const conversationIds = [...new Set(rows.map((m) => m.conversationId))];
    // Batch: the conversations (for isOfficial/kind/title/avatarUrl), and
    // the participants and hit senders rendered through one shared
    // `loadMessageListContext` (Task 13c), a fixed number of queries, no
    // per-row lookups.
    const convos = await this.conversations.find({
      where: { id: In(conversationIds) },
    });
    const convoById = new Map(convos.map((c) => [c.id, c]));
    const listContext = await this.core.loadMessageListContext(
      convos,
      rows,
      userId,
    );

    const conversations: MessageSearchConversationGroup[] = conversationIds.map(
      (conversationId) => {
        const convo = convoById.get(conversationId);
        const isOfficial = Boolean(convo?.isOfficial);
        // ENG-251: a GROUP hit is filed under the group's own identity, never
        // an arbitrary member's, `otherParticipant` (a single counterpart)
        // makes no sense for an N-member thread. Task 13c: a direct thread's
        // counterpart is rendered the way the inbox header renders it, so a
        // business thread files under the business and names no staff member.
        const isGroup = convo?.kind === ConversationKind.Group;
        return {
          conversationId,
          // PRD-372: `renderCounterpart` answers null for the member's own
          // official thread, and the member for a QueerPulse Team staff seat.
          otherParticipant: isGroup
            ? null
            : listContext.renderCounterpart(conversationId),
          isOfficial,
          kind: isGroup ? 'group' : 'direct',
          title: isGroup ? (convo?.title ?? null) : null,
          avatarUrl: isGroup ? toImageUrl(convo?.avatarUrl ?? null) : null,
        };
      },
    );

    const hits = rows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      // PRD-423: a matched chat's `@<member key>` mentions are spelled by
      // first name before the window is cut, so no token is split.
      snippet: buildSearchSnippet(
        listContext.renderText(m.conversationId, searchHitText(m)),
        query,
      ),
      sender: listContext.renderSender(m),
      ...listContext.isSentByViewer(m),
      createdAt: m.createdAt.toISOString(),
      // Coordinator follow-up (ENG-251): `kind`/`attachment` ride the same
      // `Message` row this query already selected in full, no extra query or
      // join, and are hand-mapped through the exact same resolvers
      // `toMessageResponses` uses, so a search hit's thumbnail/file name is
      // never a bare storage key.
      kind: messageKindToResponseKind(m.kind),
      attachment: resolveAttachment(m.attachment),
    }));

    return { query, hits, conversations };
  }

  /**
   * ENG-222: thin wrapper kept byte-identical in signature for the chat
   * gateway and every other existing caller, all of which only ever want the
   * stored message and have no use for the fresh-vs-replay outcome. Delegates
   * to `sendMessageWithOutcome` so there is exactly one send implementation.
   */
  async sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image' | 'document' | 'sticker',
    attachment?: AttachmentInput,
    stickerId?: string,
    asIdentityId?: string,
  ): Promise<MessageResponse> {
    const { response } = await this.sendMessageWithOutcome(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
      kind,
      attachment,
      stickerId,
      asIdentityId,
    );
    return response;
  }

  /**
   * ENG-222: same send path as `sendMessage`, but also surfaces `isNew` so a
   * caller that needs to tell a fresh create apart from an idempotent
   * `clientMessageId` replay (the HTTP `POST` controller, for the
   * `Idempotent-Replayed` header / `200` vs `201`) can do so without a second
   * write path or a second dedupe check.
   */
  async sendMessageWithOutcome(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image' | 'document' | 'sticker',
    attachment?: AttachmentInput,
    stickerId?: string,
    asIdentityId?: string,
  ): Promise<{ response: MessageResponse; isNew: boolean }> {
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
    // ENG-242: a moderator `restrict` action blocks a send over EITHER
    // transport. `POST /conversations/:id/messages` already refuses this via
    // `NotRestrictedGuard` (an HTTP-only guard), but the gateway's WS
    // `message:send` runs no guard chain at all — both funnel through this one
    // method, so the check belongs here rather than being duplicated (and
    // possibly missed) in the gateway handler. `sender` is already loaded
    // above; `liftExpiredRestriction` re-reads the SAME lazy-expiry rule
    // `JwtStrategy.validate` applies on every HTTP request, so a lapsed
    // restriction lifts here too rather than blocking a send it no longer
    // should. Thrown with the identical coded body `assertNotRestricted`
    // raises, so both transports and both guards surface one
    // `ACCOUNT_RESTRICTED_CODE` the client can key off.
    if (await this.usersService.liftExpiredRestriction(sender)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message:
          'This action is unavailable while a moderation restriction is in effect.',
        code: ACCOUNT_RESTRICTED_CODE,
      });
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
    // PRD-372: who may write into an official thread. See
    // `OFFICIAL_THREAD_READ_ONLY_CODE`. The member's reply seats the
    // QueerPulse Team's staff BEFORE it is stored, so its live frame and its
    // unread count reach them. A staff seat (the `official` identity) sends
    // as the team; `postMessage` checks that its holder is still staff.
    if (convo.isOfficial) {
      const isMemberReply =
        convo.officialMemberId === userId && !participant.leftAt;
      const isStaffSeat =
        participant.identityId ===
          (await this.officialMailboxSeats.officialIdentityId()) &&
        !participant.leftAt;
      if (isMemberReply) {
        await this.officialMailboxSeats.seatStaffForMemberReply(convo.id);
      } else if (!isStaffSeat) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You cannot reply to this thread.',
          code: OFFICIAL_THREAD_READ_ONLY_CODE,
        });
      }
    }
    // A member who LEFT a group keeps read access to history but cannot post.
    if (convo.kind === ConversationKind.Group && participant.leftAt) {
      throw new ForbiddenException('You have left this group');
    }
    // The 1:1 connection gate applies only to DIRECT member DMs — a group's
    // membership was validated at creation (and Phase 2 owns per-member gates),
    // and official threads are exempt. Picking an arbitrary "other" in a group
    // would wrongly gate on a single member.
    //
    // Hoisted (rather than scoped to the `if` below): PRD-221 reuses it after
    // the send succeeds to keep an `@`-mention of this exact person out of the
    // mention fan-out; see the `directCounterpartUserIds` comment down there.
    //
    // Task 13c: `directCounterpartUserIds` holds every user this send already
    // reaches as its one counterpart: the ordinary DM's other member, the
    // customer for a staff sender on a business mailbox thread, or every
    // staff seat for a customer writing to one.
    let directCounterpartUserIds: string[] = [];
    if (convo.kind !== ConversationKind.Group && !convo.isOfficial) {
      // Task 13c: the enforcement twin of `ConversationsService.replyGateFor`
      // as `buildConversationSummaries` feeds it, reading the same seats
      // through the same `describeDirectThreadSeats`. An unordered
      // `findOne({ userId: Not(userId) })` could return a staff sender's
      // COLLEAGUE, whose personal connection skipped this gate and left
      // `openedAt` unset, so the customer stayed refused although the
      // business had replied.
      const { threadSeats, otherSeats } = await this.core.loadDirectThreadSeats(
        conversationId,
        participant,
      );
      if (threadSeats.mailboxIdentityId) {
        // A business mailbox thread. Personal connection does not apply on
        // either side, the same `false` the inbox's `replyGate` reads. A
        // person-to-person block is enforced one step earlier: a staff member
        // blocked either way with the customer is refused by
        // `requireParticipant` above (fix round 1), and everyone else sends
        // as usual. Blocking a business as a whole is identity-level
        // blocking, applied by Task 14's `identity_blocks`.
        directCounterpartUserIds = threadSeats.isCallerMailboxSeat
          ? threadSeats.counterpartSeats.map((seat) => seat.userId)
          : threadSeats.mailboxStaffSeats.map((seat) => seat.userId);
        if (!convo.openedAt) {
          if (convo.initiatorUserId && convo.initiatorUserId !== userId) {
            await this.conversations.update(convo.id, {
              openedAt: new Date(),
            });
          } else {
            throw new ForbiddenException(
              'You can only message accepted connections',
            );
          }
        }
      } else if (otherSeats.length) {
        directCounterpartUserIds = otherSeats.map((seat) => seat.userId);
        // P0 hardening: a `blocks` row is a hard stop even if the
        // `connections` edge somehow still reads Accepted (e.g. a stale read
        // racing `SocialService.blockMember`'s transactional sever) —
        // defense-in-depth, checked before (and independent of) the
        // connection gate below. An ordinary DM has exactly one other seat.
        for (const other of otherSeats) {
          if (await this.blockFilter.isBlockedEitherWay(userId, other.userId)) {
            throw new ForbiddenException('You cannot message this member');
          }
        }
        // PRD-340 (one-tap reply): a non-connected 1:1 thread is no longer an
        // unconditional dead end for BOTH sides. `convo.openedAt` set means
        // it's already open (either side may send, exactly like a connected
        // pair). Otherwise, the member who did NOT start the thread
        // (`convo.initiatorUserId`) may still post. Their first reply is
        // what flips `openedAt` here, opening it for both from now on. The
        // initiator themselves gets the ordinary refusal until that happens,
        // which keeps the anti-spam property this gate exists for. A
        // pre-migration thread with no known initiator keeps the platform's
        // original, unconditional rule (see the migration's own comment).
        // Task 13c: a thread whose seats cannot be attributed
        // (`counterpartSeats` empty) counts as unconnected, as it does in the
        // inbox.
        const counterpartSeat =
          threadSeats.counterpartSeats.length === 1
            ? threadSeats.counterpartSeats[0]
            : undefined;
        if (
          !convo.openedAt &&
          !(
            counterpartSeat &&
            (await this.connectionsService.areConnected(
              userId,
              counterpartSeat.userId,
            ))
          )
        ) {
          if (convo.initiatorUserId && convo.initiatorUserId !== userId) {
            await this.conversations.update(convo.id, {
              openedAt: new Date(),
            });
          } else {
            throw new ForbiddenException(
              'You can only message accepted connections',
            );
          }
        }
      }
    }
    if (replyToId) {
      // ENG-256: the parent must (a) live in THIS conversation, otherwise a
      // participant of conversation A could reply-quote a message that only
      // exists in conversation B, and (b) still be VISIBLE to the sender: not
      // hidden for their own view (PRD-227 "delete for me") and not
      // at-or-before their own `clearedAt` floor. Without (b), a sender could
      // quote-reply a message they had just cleared/hidden for themselves,
      // undoing their own "delete for me"/clear-chat floor the moment they
      // read the reply back (`buildReplyTo` renders the parent's real
      // snippet). One query: `participant` (the sender's own row, already
      // loaded above by `requireParticipant`) supplies `clearedAt` in memory,
      // so only the `message_hides` check rides along as a subquery. Every
      // refusal here throws the SAME "not found" as the wrong-conversation
      // case, so no existence oracle distinguishes "wrong conversation" from
      // "hidden for you" from "before your clear point".
      const parentQuery = this.messages
        .createQueryBuilder('parent')
        .where('parent.id = :replyToId', { replyToId })
        .andWhere('parent.conversation_id = :conversationId', {
          conversationId,
        })
        .andWhere(
          `NOT EXISTS (
            SELECT 1 FROM "message_hides" "mh"
            WHERE "mh"."message_id" = parent.id AND "mh"."user_id" = :senderId
          )`,
          { senderId: userId },
        );
      if (participant.clearedAt) {
        parentQuery.andWhere('parent.created_at > :clearedAt', {
          clearedAt: participant.clearedAt.toISOString(),
        });
      }
      const parent = await parentQuery.getOne();
      if (!parent) {
        throw new NotFoundException('Replied-to message not found');
      }
    }
    // `core.postMessage` is the single write path; it hydrates the
    // frontend-contract response once (reused here and in the MESSAGE_CREATED
    // broadcast) and dedupes on `clientMessageId` so a retry / dual HTTP+WS
    // write can't duplicate.
    const { response, isNew } = await this.core.postMessage(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
      kind,
      attachment,
      stickerId,
      asIdentityId,
    );
    // `@`-mention fan-out: the same best-effort `MentionNotificationService`
    // community posts and forum threads already use, wired into the ONE write
    // path both the HTTP `POST` and the gateway's `message:send` funnel
    // through (`MessagingService.sendMessage` -> here), so a mention notifies
    // its target regardless of which transport sent it. Reuses the existing
    // `mention` notification type (no migration) and its block/mute filtering
    // and cross-mention dedup. `isNew` gates this to a genuinely fresh insert
    // — an idempotency-key replay (retry, or the dual HTTP+WS write path
    // racing itself) must not re-notify a mention that already fired once.
    //
    // PRD-221: `directCounterpartUserIds` (set above, non-empty only for a
    // DIRECT non-official DM) is excluded from the fan-out. In a 1:1 thread
    // the mentioned member and the message's only possible recipient are
    // necessarily the same person — `PushMessageListener` already tells them
    // a message arrived, so a SEPARATE "mentioned you" bell row/push for the
    // identical message is pure duplication (and, per the report, the mention
    // row's link target doesn't even point at the message). A GROUP is
    // different: the "new message" push is a generic, unaddressed signal
    // shared by every member, while `@name` inside it is the one signal that
    // says "this one is about you specifically" among several participants —
    // real triage value the generic push doesn't carry, and the same fact the
    // "Mentions" inbox (`mentions-inbox.service.ts`) exists to surface across
    // the app. So only the exact-counterpart case is excluded here; a mention
    // of a fellow GROUP participant still earns its own notification.
    //
    // ENG-400: every recipient of this fan-out, for every entity kind, is
    // held to the conversation's current participants
    // (`MentionNotificationService.restrictGroupsToSource`). A `c/`, `e/`,
    // `b/` or `t/` mention still renders as a link in the thread; the
    // community staff, host, listing owner or thread author it names hears
    // about it only when they already sit in this conversation.
    //
    // Carried 09-15 item 2: an attachment message's `body` is the client's
    // localized "Photo"/"Document" fallback, and the member's own words live
    // in the sanitized `attachment.caption`. The caption is what gets scanned
    // and excerpted, and an uncaptioned attachment contributes no text.
    const mentionText = this.mentionTextFor(response, body);
    if (isNew && mentionText) {
      await this.mentions.notify(
        mentionText,
        userId,
        {
          actorId: userId,
          source: 'message',
          conversationId,
          messageId: response.id,
          // Cut by character: the excerpt is stored in the notification's
          // `jsonb` payload, which refuses a lone surrogate.
          excerpt: truncateCharacters(mentionText, 140),
          // PRD-423: the bell and the Mentions inbox read this server-side
          // key to name the mentioner by first name, with no profile link.
          ...(convo.isGoTogetherChat ? { isGoTogetherChat: true } : {}),
        },
        directCounterpartUserIds,
      );
    }
    return { response, isNew };
  }

  /**
   * The text a sent message's `@`-mention fan-out scans and excerpts. A plain
   * text message contributes its `body`. A gif, image, document or sticker
   * message contributes its sanitized attachment caption, or nothing when the
   * member typed none: its `body` holds the client's localized fallback label
   * ("Photo", "Document"), which is display filler with no mention in it.
   * The kind rule lives in `messageMentionText` (`common/mentions.ts`), shared
   * with the unread-mention flag and the group mention push.
   */
  private mentionTextFor(response: MessageResponse, body: string): string {
    return messageMentionText({
      kind: response.kind,
      body,
      attachment: response.attachment,
    });
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
   *
   * PRD-361: the tombstone keeps its `body` and `attachment` server-side for
   * an evidence hold (`attachmentPurgeAfter`), so a recipient can still report
   * an unsent image and a moderator can still see it. Nothing is purged here;
   * `MessageEvidenceHoldSweepService` does that once the hold ends.
   *
   * ENG-245: a STAFF delete (not the author) writes a
   * `message_deleted_by_staff` audit row in the same transaction as the
   * tombstone. `staffContext` (reason, note, report) is read only on that
   * branch.
   */
  async deleteMessage(
    conversationId: string,
    messageId: string,
    userId: string,
    staffContext: DeleteMessageDto = {},
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
    // ENG-241: a system pill is an audit row, not a message anyone
    // authored. Refuse before the deletedAt idempotency check so this
    // never quietly returns { ok: true } for a system row either.
    if (message.kind === MessageKind.System) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'A system message cannot be deleted',
        code: SYSTEM_MESSAGE_IMMUTABLE_CODE,
      });
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
    } else if (message.senderIdentityId) {
      // Task 7: an author who has since lost their staff standing on the
      // identity this message was sent as (e.g. removed from the business's
      // team) must not keep deleting messages sent under it. A platform
      // staff takedown (the branch above) is a moderation action and carries
      // no such requirement.
      //
      // CW-28: `isDeletingOwnMessage` is set here alone, after `isAuthor`
      // above has already confirmed this human wrote the message being
      // deleted, so a moderation-removed persona may still remove its own
      // past content. `editMessage`'s identical guard call below omits it,
      // so every other write still meets the plain `IDENTITY_REMOVED`
      // refusal.
      await this.core.assertMaySendAs(
        conversationId,
        userId,
        message.senderIdentityId,
        { isDeletingOwnMessage: true },
      );
    }

    // Conditional soft-delete: only the row still un-deleted is tombstoned. Two
    // concurrent deletes both pass the `message.deletedAt` guard above, but the
    // `deleted_at IS NULL` predicate lets exactly ONE update affect a row — so
    // MESSAGE_DELETED is broadcast once, never on a repeat/no-op delete.
    let affected: number;
    if (isAuthor) {
      affected = await this.tombstoneWithEvidenceHold(
        this.messages.createQueryBuilder(),
        conversationId,
        messageId,
      );
    } else {
      // ENG-245. Everything that can refuse runs BEFORE the transaction, so a
      // refusal never leaves a tombstone behind it.
      if (staffContext.reportId) {
        await this.assertReportNamesMessage(staffContext.reportId, messageId);
      }
      // Guarded on a non-null sender: an erased author's `senderId` is NULL,
      // and TypeORM drops a `null` from `where`, which would match any row.
      const authorProfile = message.senderId
        ? await this.profiles.findOne({
            where: { userId: message.senderId },
            select: { userId: true, firstName: true, lastName: true },
          })
        : null;
      const authorName = authorProfile
        ? `${authorProfile.firstName} ${authorProfile.lastName}`.trim()
        : null;
      affected = await this.messages.manager.transaction(async (manager) => {
        const tombstoned = await this.tombstoneWithEvidenceHold(
          manager.getRepository(Message).createQueryBuilder(),
          conversationId,
          messageId,
        );
        // Only the call that actually tombstoned the row records it, so a
        // concurrent repeat delete never writes a second audit row.
        if (tombstoned === 1) {
          const auditLogs = manager.getRepository(ModAuditLog);
          await auditLogs.save(
            auditLogs.create({
              reportId: staffContext.reportId ?? null,
              actorId: userId,
              action: MESSAGE_DELETED_BY_STAFF_AUDIT_ACTION,
              targetUserId: message.senderId,
              targetName: authorName || null,
              reasonCode: staffContext.reasonCode ?? null,
              note: staffMessageDeletionAuditNote(
                messageId,
                conversationId,
                staffContext.note,
              ),
              duration: null,
            }),
          );
        }
        return tombstoned;
      });
    }

    if (affected === 1) {
      this.eventEmitter.emit(MESSAGE_DELETED, {
        conversationId,
        messageId,
      } satisfies MessageDeletedEvent);
    }
    return { ok: true };
  }

  /**
   * The tombstone write both delete branches share: `deleted_at = now()` and
   * the PRD-361 evidence hold, on the still-live row only. Takes the query
   * builder so the staff branch can run it inside its audit transaction.
   * Returns the affected row count (1 or 0).
   */
  private async tombstoneWithEvidenceHold(
    queryBuilder: SelectQueryBuilder<Message>,
    conversationId: string,
    messageId: string,
  ): Promise<number> {
    const result = await queryBuilder
      .update(Message)
      .set({
        deletedAt: () => 'now()',
        // A compile-time integer constant, never caller input.
        attachmentPurgeAfter: () =>
          `now() + interval '${MESSAGE_DELETE_EVIDENCE_HOLD_DAYS} days'`,
      })
      .where('id = :messageId', { messageId })
      .andWhere('conversation_id = :conversationId', { conversationId })
      .andWhere('deleted_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  /** ENG-245: a staff delete that cites a report must cite one about THIS
   *  message, or the audit trail would hang the takedown off an unrelated
   *  case. Same coded 400 for "no such report" and "a different subject". */
  private async assertReportNamesMessage(
    reportId: string,
    messageId: string,
  ): Promise<void> {
    const report = await this.messages.manager.findOne(Report, {
      where: { id: reportId },
      select: { id: true, subjectType: true, subjectId: true },
    });
    if (
      !report ||
      report.subjectType !== ReportSubjectType.Message ||
      report.subjectId !== messageId
    ) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'That report is not about this message',
        code: REPORT_SUBJECT_MISMATCH_CODE,
      });
    }
  }

  /**
   * Delete the stored object(s) behind a tombstone whose evidence hold has
   * ended, once no OTHER message still needs them. Called by
   * `MessageEvidenceHoldSweepService` after it has blanked the row, never by
   * `deleteMessage` itself (PRD-361: an unsend keeps the bytes for the hold).
   *
   * Why the bytes go at all: a tombstone that kept its object forever left the
   * uploader a BLANK tile in Settings → My uploads (`FilesController` refuses a
   * `message-image` key no un-deleted message references), and it mirrors
   * `EventPhotosService.remove` and the stance `reports/report-evidence.ts`
   * argues: keeping a photograph of an identifiable person indefinitely after a
   * takedown is the worse failure. The hold bounds that to
   * `MESSAGE_DELETE_EVIDENCE_HOLD_DAYS`, longer only while a report is open.
   *
   * Best-effort by design: a bucket failure is logged and swallowed. The sweep
   * has already NULLed the row's attachment, so a failed object is unreferenced
   * and `StorageMaintenanceService`'s orphan sweep can reclaim it.
   */
  async purgeReleasedAttachmentBytes(
    messageId: string,
    attachment: GifAttachment | DocumentAttachment | StickerAttachment | null,
  ): Promise<void> {
    for (const key of messageAttachmentStorageKeys(attachment)) {
      try {
        if (await this.isKeyStillNeededByAnotherMessage(key, messageId)) {
          continue;
        }
        await this.storage.deleteObjectByReference(key);
      } catch (error) {
        this.logger.error(
          `Failed to purge attachment object ${key} for deleted message ${messageId}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * True when some OTHER message still needs this key: a live message, or a
   * tombstone whose evidence hold has not been swept yet.
   *
   * A FORWARD reuses the ORIGINAL key rather than copying the object (see
   * `MessagingCoreService.senderCanForwardAttachment`), so one object can be
   * referenced by many messages across many conversations. Purging on the
   * first released tombstone alone would blank every live forward of that
   * photo, and (PRD-361) would destroy the evidence another held tombstone of
   * the same object still carries, possibly one under an open report. A
   * tombstone the sweep has already cleaned has a NULL `attachmentPurgeAfter`
   * (and a NULL attachment), so it never keeps the object alive. Matches both
   * stored forms, mirroring `FilesController.isMessageAttachmentParticipant`.
   *
   * `withDeleted()` plus the explicit predicate, so the held-tombstone half is
   * actually visible to the probe and the live-message half never depends on
   * TypeORM's implicit `@DeleteDateColumn` filter.
   */
  private async isKeyStillNeededByAnotherMessage(
    storageKey: string,
    messageId: string,
  ): Promise<boolean> {
    return this.messages
      .createQueryBuilder('message')
      .withDeleted()
      .where("message.attachment ->> 'url' IN (:...attachmentForms)", {
        attachmentForms: [storageKey, `/files/${storageKey}`],
      })
      .andWhere('message.id != :messageId', { messageId })
      .andWhere(
        '(message.deletedAt IS NULL OR message.attachmentPurgeAfter IS NOT NULL)',
      )
      .getExists();
  }

  /**
   * Edit a message's text in place: the `body` of a text message, or the
   * caption of a photo, document or GIF (ENG-405); a sticker is refused.
   * An empty edit clears a caption and is refused on every other kind.
   * Author-only, within a 15-minute window of `createdAt`, and only while
   * the message is not (soft-)deleted. Stamps `editedAt` and emits
   * `MESSAGE_UPDATED` so live sockets in the conversation see the edit.
   * Mirrors `deleteMessage`'s guard shape and is stricter: a repeat call
   * keeps overwriting the text and the edited timestamp, and the edit window
   * is enforced on the server as the authority, even though the client also
   * hides the Edit action past 15 minutes.
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
    // ENG-241: a system pill is an audit row, not a message anyone
    // authored. Refuse before the author check below (its `senderId` is
    // the actor purely so it renders in the room, not because they wrote it).
    if (message.kind === MessageKind.System) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'A system message cannot be edited',
        code: SYSTEM_MESSAGE_IMMUTABLE_CODE,
      });
    }
    // ENG-405: see `MESSAGE_KIND_NOT_EDITABLE_CODE`.
    if (UNEDITABLE_MESSAGE_KINDS.includes(message.kind)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'A sticker message cannot be edited',
        code: MESSAGE_KIND_NOT_EDITABLE_CODE,
      });
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException('You can only edit your own messages');
    }
    if (message.senderIdentityId) {
      // Task 7: the author must still be entitled to act as the identity
      // this message was sent as. A staff member removed from a business's
      // team since the original send must not keep rewriting messages sent
      // under its name.
      await this.core.assertMaySendAs(
        conversationId,
        userId,
        message.senderIdentityId,
      );
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
    // ENG-405: a photo, document or GIF bubble renders its caption, and its
    // `body` is only the send-time "Photo"/"Document"/"GIF" fallback. The edit
    // therefore lands on the caption, and `body` keeps the fallback the inbox
    // preview and push already read. Search and mentions read the caption.
    // An empty edit clears a caption (the DTO allows it for that reason); a
    // text message keeps the `@MinLength(1)`-style refusal it always had.
    if (CAPTION_EDIT_MESSAGE_KINDS.includes(message.kind)) {
      message.attachment = this.withEditedCaption(message.attachment, body);
    } else if (body.trim().length === 0) {
      throw new BadRequestException(
        'body must be longer than or equal to 1 characters',
      );
    } else {
      message.body = body;
    }
    message.editedAt = new Date();
    const saved = await this.messages.save(message);
    const view = toMessageView(saved);
    // `hasViewerLeftConversation` is deliberately omitted (defaults to
    // `false`): `requireActiveParticipant` above already proved this editor
    // has not left, so they are always an active participant here.
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

  /**
   * ENG-405: the photo, document or GIF attachment with its caption replaced
   * by `editedText`, cleaned through the same `sanitizeAttachmentCaption` pass
   * a send uses. Text that sanitizes down to nothing leaves no caption, so the
   * bubble shows the bare media and previews keep their "Photo"/"Document"/
   * "GIF" fallback. Refuses a caption longer than a send may carry, and a row
   * with no photo, document or GIF attachment to hold one.
   */
  private withEditedCaption(
    attachment: GifAttachment | DocumentAttachment | StickerAttachment | null,
    editedText: string,
  ): GifAttachment | DocumentAttachment {
    if (!attachment || isStickerAttachment(attachment)) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'This message has no caption to edit',
        code: MESSAGE_KIND_NOT_EDITABLE_CODE,
      });
    }
    if (!maxLength(editedText, MAX_ATTACHMENT_CAPTION_LENGTH)) {
      throw new BadRequestException(
        `A caption can be at most ${MAX_ATTACHMENT_CAPTION_LENGTH} characters`,
      );
    }
    const caption = this.core.sanitizeAttachmentCaption(editedText);
    const withoutCaption = { ...attachment };
    delete withoutCaption.caption;
    return caption === undefined
      ? withoutCaption
      : { ...withoutCaption, caption };
  }
}
