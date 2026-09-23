import { EntityManager, In, SelectQueryBuilder } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import type { IdentityKind } from '../identities/entities/identity.entity';
import type {
  IdentitiesService,
  IdentityDescription,
} from '../identities/identities.service';
import {
  renderMessageSender,
  type SenderIdentityContext,
} from '../messaging/author-summary';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import {
  DocumentAttachment,
  GifAttachment,
  isDocumentAttachment,
  isStickerAttachment,
  Message,
  MessageKind,
  StickerAttachment,
} from '../messaging/entities/message.entity';
import { EXACT_CREATED_AT_SELECT } from '../messaging/message-history-cursor';
import {
  describeDirectThreadSeats,
  isEverySeatPersonal,
  renderDirectCounterpart,
  seatExcludedFromMailboxPredicate,
  staffSeatExcludedFromMailboxPredicate,
} from '../messaging/mailbox-seats';
import { FORMER_MEMBER_DISPLAY_NAME } from '../messaging/message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from '../messaging/message-visibility-predicates';
import { toBareKey } from '../storage/bare-key';
import { contentTypeForStorageKey } from '../storage/served-object';
import { Profile } from '../users/entities/profile.entity';

/**
 * Everything this file needs from `IdentitiesService` to render a business
 * mailbox counterpart or sender: the identity's own kind (`getByIds`, to
 * partition a direct thread's seats) and its display fields (`describeIdentities`,
 * to name the business). This narrow `Pick` lets a caller building the export
 * pass the real injected `IdentitiesService` straight through.
 */
export type ExportIdentities = Pick<
  IdentitiesService,
  'getByIds' | 'describeIdentities'
>;

/**
 * PRD-370: the `messages` category of the Art. 20 archive, bounded.
 *
 * Two archive keys come out of the one category:
 *
 *  - `messages`: the member's OWN messages, each with enough context to stand
 *    alone (which conversation, what kind, any attachment and where its bytes
 *    sit under `media/`, whether it was a reply or a forward).
 *  - `reportedConversations`: every conversation where the member filed a
 *    message report or a member report about the person on the other side,
 *    with the messages the member could see there from EVERYONE in it. A
 *    member documenting harassment gets both halves of the thread they already
 *    reported, and nothing from a conversation they did not.
 *
 * BOUNDED. Both are read newest-first in keyset-paginated pages (never one
 * unbounded find) and capped: 50,000 own messages, 5,000 per reported
 * conversation, newest kept. A cut list is marked `truncated` (on the
 * conversation entry, or `manifest.messages.ownMessagesTruncated` for the own
 * list, which has to stay a plain array for the CSV export and the frontend
 * archive contract). Both keys still land in the one `data_export_job.data`
 * jsonb value; see `AccountExportService.build`'s size note for what the next
 * step is if the caps ever stop being enough.
 *
 * `reportedConversations` needs TWO more ceilings, because the per-conversation
 * one bounds each entry and nothing bounded how many entries there are. A
 * member who filed reports across hundreds of threads would have every one of
 * them read in full and held in memory at once, to be serialised into that
 * single jsonb value: 5,000 messages each was a bound on the wrong axis. So the
 * list is capped at {@link REPORTED_CONVERSATIONS_EXPORT_CAP} conversations AND
 * at {@link REPORTED_CONVERSATION_TOTAL_MESSAGES_EXPORT_CAP} messages across
 * all of them, whichever binds first. Conversations come newest-reported first,
 * so what survives a cut is the most recent. A list cut by either ceiling is
 * flagged as `manifest.messages.reportedConversationsTruncated`, mirroring
 * `ownMessagesTruncated` and for the same reason: the array itself has to stay
 * plain for the archive contract.
 */

export const OWN_MESSAGES_EXPORT_CAP = 50_000;
export const REPORTED_CONVERSATION_MESSAGES_EXPORT_CAP = 5_000;
/** How many reported conversations the archive carries at all. */
export const REPORTED_CONVERSATIONS_EXPORT_CAP = 200;
/** Messages across every reported conversation together. */
export const REPORTED_CONVERSATION_TOTAL_MESSAGES_EXPORT_CAP = 20_000;

/** Rows per keyset page. */
const MESSAGE_EXPORT_PAGE_SIZE = 2_000;
/** Ids per `IN (...)` lookup. */
const ID_LOOKUP_CHUNK_SIZE = 1_000;
/** Title of the official QueerPulse thread when it carries none. */
const OFFICIAL_CONVERSATION_TITLE = 'QueerPulse';

const UUID_SQL_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export type ExportedConversationKind = 'direct' | 'group' | 'official';

export interface ExportedOwnMessageAttachment {
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** The file's path inside the export's `media/` folder when the zip carries
   *  it, else null. Filled by `attachMessageMediaPaths`. Always null for a
   *  sticker: its artwork is admin-owned, shared platform catalogue, so it is
   *  never bundled into this member's own personal media zip. */
  mediaPath: string | null;
  /** A sticker's resolved, fetchable image URL. Null for every other
   *  attachment kind, which instead resolve through `mediaPath`. */
  url: string | null;
}

export interface ExportedOwnMessage {
  id: string;
  conversationId: string;
  /** Group title, the counterpart's display name for a DM ("Former member"
   *  once they erased their account), or the official thread's name. */
  conversationTitle: string | null;
  conversationKind: ExportedConversationKind | null;
  kind: MessageKind;
  body: string;
  attachment: ExportedOwnMessageAttachment | null;
  replyToId: string | null;
  isForwarded: boolean;
  sentAt: string;
  editedAt: string | null;
}

export interface ExportedReportedConversationMessage {
  id: string;
  senderDisplayName: string;
  isOwnMessage: boolean;
  kind: MessageKind;
  body: string;
  attachment: {
    fileName: string | null;
    mimeType: string | null;
    /** A sticker's resolved, fetchable image URL; null for every other
     *  attachment kind. */
    url: string | null;
  } | null;
  sentAt: string;
}

export interface ExportedReportedConversation {
  conversationId: string;
  conversationTitle: string | null;
  conversationKind: ExportedConversationKind | null;
  /** True when the conversation held more than the cap; the newest are kept. */
  truncated: boolean;
  messages: ExportedReportedConversationMessage[];
}

/**
 * Attachment object -> storage key, for `attachMessageMediaPaths`. A WeakMap
 * so the key never becomes an enumerable field (the archive already lists keys
 * under `media`; a message row does not need a second copy) and never outlives
 * the build.
 */
const storageKeyByExportedAttachment = new WeakMap<
  ExportedOwnMessageAttachment,
  string
>();

/** Own-message lists that hit {@link OWN_MESSAGES_EXPORT_CAP}. */
const truncatedOwnMessageLists = new WeakSet<ExportedOwnMessage[]>();

export function isOwnMessageListTruncated(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    truncatedOwnMessageLists.has(value as ExportedOwnMessage[])
  );
}

/**
 * Reported-conversation lists cut by {@link REPORTED_CONVERSATIONS_EXPORT_CAP}
 * or {@link REPORTED_CONVERSATION_TOTAL_MESSAGES_EXPORT_CAP}. Same WeakSet
 * device as the own-message list above, for the same reason: the array is part
 * of the archive contract and cannot carry a flag of its own.
 */
const truncatedReportedConversationLists = new WeakSet<
  ExportedReportedConversation[]
>();

export function isReportedConversationListTruncated(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    truncatedReportedConversationLists.has(
      value as ExportedReportedConversation[],
    )
  );
}

interface MessagePageRow {
  id: string;
  conversationId: string;
  senderId: string | null;
  /** Business mailboxes: which identity this message was sent AS, mirroring
   *  `Message.senderIdentityId`'s own doc. Null for a genuinely personal
   *  message and wherever `senderId` is null. Read so `renderMessageSender`
   *  can name a mailbox message's sender as the business it was sent for,
   *  the same way every in-app read already does. */
  senderIdentityId: string | null;
  body: string;
  kind: MessageKind;
  attachment: GifAttachment | DocumentAttachment | StickerAttachment | null;
  replyToId: string | null;
  forwarded: boolean;
  createdAt: Date | string;
  editedAt: Date | string | null;
  exactCreatedAt: string;
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}

function chunked<Item>(items: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Newest-first keyset read of up to `cap` live messages matching `scope`,
 * returned oldest-first. Reads `cap + 1` rows so an exactly-full list is not
 * mistaken for a cut one. The cursor carries the microsecond-exact
 * `created_at` (`EXACT_CREATED_AT_SELECT`), so a page boundary never skips or
 * repeats a row. Tombstones are excluded by the soft-delete filter.
 */
async function readNewestMessages(
  manager: EntityManager,
  scope: (queryBuilder: SelectQueryBuilder<Message>) => void,
  cap: number,
): Promise<{ rows: MessagePageRow[]; isTruncated: boolean }> {
  const rows: MessagePageRow[] = [];
  const wantedCount = cap + 1;
  let cursor: { exactCreatedAt: string; id: string } | null = null;
  while (rows.length < wantedCount) {
    const pageSize = Math.min(
      MESSAGE_EXPORT_PAGE_SIZE,
      wantedCount - rows.length,
    );
    const queryBuilder = manager
      .getRepository(Message)
      .createQueryBuilder('m')
      .select('m.id', 'id')
      .addSelect('m.conversation_id', 'conversationId')
      .addSelect('m.sender_id', 'senderId')
      .addSelect('m.sender_identity_id', 'senderIdentityId')
      .addSelect('m.body', 'body')
      .addSelect('m.kind', 'kind')
      .addSelect('m.attachment', 'attachment')
      .addSelect('m.reply_to_id', 'replyToId')
      .addSelect('m.forwarded', 'forwarded')
      .addSelect('m.created_at', 'createdAt')
      .addSelect('m.edited_at', 'editedAt')
      .addSelect(EXACT_CREATED_AT_SELECT, 'exactCreatedAt');
    scope(queryBuilder);
    if (cursor) {
      queryBuilder.andWhere(
        '(m.created_at, m.id) < (CAST(:cursorCreatedAt AS timestamptz), CAST(:cursorId AS uuid))',
        { cursorCreatedAt: cursor.exactCreatedAt, cursorId: cursor.id },
      );
    }
    const page = await queryBuilder
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .limit(pageSize)
      .getRawMany<MessagePageRow>();
    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }
    const lastRow = page[page.length - 1]!;
    cursor = { exactCreatedAt: lastRow.exactCreatedAt, id: lastRow.id };
  }
  return {
    rows: rows.slice(0, cap).reverse(),
    isTruncated: rows.length > cap,
  };
}

interface AttachmentFacts {
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  storageKey: string | null;
  /** A sticker's resolved, fetchable image URL; null for every other
   *  attachment kind (those resolve through `storageKey`/`mediaPath` instead). */
  url: string | null;
}

/**
 * What the archive can say about an attachment without touching storage.
 *
 * Checks `isStickerAttachment` before `isDocumentAttachment` (see that
 * discriminator's own doc): a sticker's bytes are admin-owned, shared
 * platform catalogue, so it gets `storageKey: null` (excluded from the
 * personal media zip) and its own resolved `url`, built from its `label` and
 * `toImageUrl`.
 */
function describeAttachment(
  kind: MessageKind,
  attachment: GifAttachment | DocumentAttachment | StickerAttachment | null,
): AttachmentFacts | null {
  if (!attachment) {
    return null;
  }
  if (isStickerAttachment(attachment)) {
    return {
      fileName: attachment.label,
      mimeType: 'image/png',
      sizeBytes: null,
      storageKey: null,
      url: toImageUrl(attachment.url),
    };
  }
  if (isDocumentAttachment(attachment)) {
    return {
      fileName: attachment.fileName || null,
      mimeType:
        attachment.contentType || contentTypeForStorageKey(attachment.url),
      sizeBytes:
        typeof attachment.byteSize === 'number' ? attachment.byteSize : null,
      storageKey: attachment.url,
      url: null,
    };
  }
  if (kind === MessageKind.Image) {
    const bareKey = toBareKey(attachment.url);
    const basename = bareKey.split('/').pop() ?? null;
    return {
      fileName: basename,
      mimeType: contentTypeForStorageKey(bareKey),
      sizeBytes: null,
      storageKey: attachment.url,
      url: null,
    };
  }
  // A picked GIF: a third-party URL, no file of the member's to point at.
  return {
    fileName: null,
    mimeType: 'image/gif',
    sizeBytes: null,
    storageKey: null,
    url: null,
  };
}

interface ConversationContext {
  title: string | null;
  kind: ExportedConversationKind;
}

/**
 * The conversationTitle for one DIRECT, non-official thread, from `userId`'s
 * own seat: the counterpart's display name for an ordinary DM, and Task 13f's
 * fix for a business mailbox thread, the business's own name for a customer
 * and the customer's own name for a staff exporter, exactly as
 * `renderDirectCounterpart` renders it for every in-app header. The export is
 * the customer's own legal record, so accuracy here means naming whichever
 * side of the conversation the app itself showed them.
 *
 * Falls back to {@link FORMER_MEMBER_DISPLAY_NAME} whenever `ownSeat` itself
 * could not be found (defensive; every conversation id here came from
 * `userId`'s own participation), whenever `renderDirectCounterpart` returns
 * null (a staff exporter's ambiguous customer seat, a data integrity
 * anomaly), or whenever `otherSeats` is empty, mirroring the "other member
 * erased their account" fallback this function replaces.
 *
 * Fix round 1: `otherSeats` empty is an ORDINARY personal DM whose
 * counterpart erased their account. `conversation_participants.user_id`
 * cascades on delete, so their seat row is simply gone, mailbox or not.
 * `renderDirectCounterpart` reads an empty `otherSeats` as "no counterpart
 * seat at all" and answers with `FORMER_IDENTITY_AUTHOR` ("Former business"),
 * the placeholder for a deleted MAILBOX, because it has no way to tell "the
 * seat is gone" from "the seat was never a business" once the row itself is
 * gone. This function is the one place that still knows which of the two
 * this actually is, so it checks `otherSeats.length` itself and answers
 * "Former member" before `renderDirectCounterpart` ever gets a chance to
 * guess wrong. A genuinely deleted BUSINESS mailbox is a distinct case: an
 * identity's own row is never deleted on a member's account erasure (see
 * `Message.senderIdentityId`'s own doc), so a mailbox thread's seats persist
 * across every staff member's own account being erased, one at a time.
 * Deleting the business itself is a different event: the listing/persona/
 * company row's own identities cascade away with it (see
 * `1821200000000-AddIdentities.ts`'s FK), which empties `otherSeats` the
 * same way an ordinary DM counterpart's account erasure does, and the
 * `otherSeats.length === 0` branch above answers "Former member" for both
 * cases alike.
 *
 * Task 13g: `isOwnSeatExcludedFromMailbox` is true when the block rule takes
 * the exporter's own staff seat out of this thread. The exporter's own
 * messages stay in their archive, and the thread is then titled with the
 * business's own name, so the export does not keep telling a blocked staff
 * member how the customer who blocked them currently presents themself.
 * Task 14a: a departed staff seat is taken out the same way, both rules read
 * from `staffSeatExcludedFromMailboxPredicate`, so a former employee's
 * archive does not keep naming the customers of a business they left.
 */
export function resolveDirectConversationTitleForExport(
  ownSeat: ConversationParticipant | undefined,
  otherSeats: ConversationParticipant[],
  identityKindById: ReadonlyMap<string, IdentityKind>,
  identityDescriptionById: ReadonlyMap<string, IdentityDescription>,
  profileByUser: ReadonlyMap<string, Profile>,
  isOwnSeatExcludedFromMailbox = false,
): string {
  if (!ownSeat || otherSeats.length === 0) {
    return FORMER_MEMBER_DISPLAY_NAME;
  }
  const ownThreadSeats = describeDirectThreadSeats(
    ownSeat.identityId,
    otherSeats,
    identityKindById,
  );
  if (isOwnSeatExcludedFromMailbox && ownThreadSeats.isCallerMailboxSeat) {
    return (
      identityDescriptionById.get(ownSeat.identityId)?.displayName ??
      FORMER_MEMBER_DISPLAY_NAME
    );
  }
  const counterpart = renderDirectCounterpart(
    ownThreadSeats,
    identityKindById,
    identityDescriptionById,
    profileByUser,
  );
  return counterpart?.displayName ?? FORMER_MEMBER_DISPLAY_NAME;
}

/**
 * Task 13g: which of the exporter's own STAFF seats the block rule takes out
 * of their thread, answered in one query. Task 14a: the departed-staff rule
 * too, both read from `staffSeatExcludedFromMailboxPredicate`. Only a staff
 * seat can be excluded, so an exporter holding none costs no query.
 */
async function loadMailboxExcludedConversationIds(
  manager: EntityManager,
  userId: string,
  ownStaffSeats: ReadonlyArray<ConversationParticipant>,
): Promise<Set<string>> {
  if (ownStaffSeats.length === 0) {
    return new Set();
  }
  const rows = await manager
    .getRepository(ConversationParticipant)
    .createQueryBuilder('export_seat')
    .select('export_seat.conversation_id', 'conversationId')
    .where('export_seat.user_id = :exporterUserId', { exporterUserId: userId })
    .andWhere('export_seat.conversation_id IN (:...staffConversationIds)', {
      staffConversationIds: ownStaffSeats.map((seat) => seat.conversationId),
    })
    .andWhere(
      staffSeatExcludedFromMailboxPredicate(
        'export_seat.conversation_id',
        'export_seat.user_id',
      ),
    )
    .getRawMany<{ conversationId: string }>();
  return new Set(rows.map((row) => row.conversationId));
}

/** Title and kind for each conversation, in a few batched lookups per chunk. */
async function loadConversationContexts(
  manager: EntityManager,
  userId: string,
  conversationIds: string[],
  identities: ExportIdentities,
): Promise<Map<string, ConversationContext>> {
  const contexts = new Map<string, ConversationContext>();
  for (const idChunk of chunked(conversationIds, ID_LOOKUP_CHUNK_SIZE)) {
    const conversations = await manager.getRepository(Conversation).find({
      where: { id: In(idChunk) },
      select: { id: true, isOfficial: true, kind: true, title: true },
    });
    const directConversationIds = conversations
      .filter(
        (conversation) =>
          !conversation.isOfficial &&
          conversation.kind === ConversationKind.Direct,
      )
      .map((conversation) => conversation.id);
    // The full seat list of every direct conversation in this chunk,
    // counterpart AND `userId`'s own seat alike: Task 13f needs the caller's
    // own seat too, to tell a mailbox thread from an ordinary DM through
    // `describeDirectThreadSeats`.
    const seats = directConversationIds.length
      ? await manager.getRepository(ConversationParticipant).find({
          where: { conversationId: In(directConversationIds) },
          select: {
            id: true,
            conversationId: true,
            userId: true,
            identityId: true,
            leftAt: true,
          },
        })
      : [];
    const seatsByConversation = new Map<string, ConversationParticipant[]>();
    for (const seat of seats) {
      const seatsForConversation =
        seatsByConversation.get(seat.conversationId) ?? [];
      seatsForConversation.push(seat);
      seatsByConversation.set(seat.conversationId, seatsForConversation);
    }
    const identityKindById = new Map(
      (await identities.getByIds(seats.map((seat) => seat.identityId))).map(
        (identity) => [identity.id, identity.kind],
      ),
    );
    const identityDescriptionById = await identities.describeIdentities(
      seats.map((seat) => seat.identityId),
    );
    const otherUserIds = [
      ...new Set(
        seats
          .filter((seat) => seat.userId !== userId)
          .map((seat) => seat.userId),
      ),
    ];
    const profileRows = otherUserIds.length
      ? await manager.getRepository(Profile).find({
          where: { userId: In(otherUserIds) },
        })
      : [];
    const profileByUser = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const mailboxExcludedConversationIds =
      await loadMailboxExcludedConversationIds(
        manager,
        userId,
        seats.filter(
          (seat) =>
            seat.userId === userId &&
            identityKindById.has(seat.identityId) &&
            !isEverySeatPersonal([seat], identityKindById),
        ),
      );
    for (const conversation of conversations) {
      if (conversation.isOfficial) {
        contexts.set(conversation.id, {
          title: conversation.title ?? OFFICIAL_CONVERSATION_TITLE,
          kind: 'official',
        });
      } else if (conversation.kind === ConversationKind.Group) {
        contexts.set(conversation.id, {
          title: conversation.title,
          kind: 'group',
        });
      } else {
        const conversationSeats =
          seatsByConversation.get(conversation.id) ?? [];
        const ownSeat = conversationSeats.find(
          (seat) => seat.userId === userId,
        );
        const otherSeats = conversationSeats.filter((seat) => seat !== ownSeat);
        contexts.set(conversation.id, {
          title: resolveDirectConversationTitleForExport(
            ownSeat,
            otherSeats,
            identityKindById,
            identityDescriptionById,
            profileByUser,
            mailboxExcludedConversationIds.has(conversation.id),
          ),
          kind: 'direct',
        });
      }
    }
  }
  return contexts;
}

/** `messages`: the member's own messages, newest 50,000, oldest-first. */
export async function buildOwnMessagesExport(
  manager: EntityManager,
  userId: string,
  identities: ExportIdentities,
): Promise<ExportedOwnMessage[]> {
  const { rows, isTruncated } = await readNewestMessages(
    manager,
    (queryBuilder) => {
      queryBuilder
        .where('m.sender_id = :ownerUserId', { ownerUserId: userId })
        // A system pill names the member as an event's actor; they did not
        // write it.
        .andWhere('m.kind <> :systemKind', { systemKind: MessageKind.System });
    },
    OWN_MESSAGES_EXPORT_CAP,
  );
  const contexts = await loadConversationContexts(
    manager,
    userId,
    [...new Set(rows.map((row) => row.conversationId))],
    identities,
  );
  const exported = rows.map((row): ExportedOwnMessage => {
    const facts = describeAttachment(row.kind, row.attachment);
    const attachment: ExportedOwnMessageAttachment | null = facts
      ? {
          fileName: facts.fileName,
          mimeType: facts.mimeType,
          sizeBytes: facts.sizeBytes,
          mediaPath: null,
          url: facts.url,
        }
      : null;
    if (attachment && facts?.storageKey) {
      storageKeyByExportedAttachment.set(attachment, facts.storageKey);
    }
    const context = contexts.get(row.conversationId);
    return {
      id: row.id,
      conversationId: row.conversationId,
      conversationTitle: context?.title ?? null,
      conversationKind: context?.kind ?? null,
      kind: row.kind,
      body: row.body,
      attachment,
      replyToId: row.replyToId,
      isForwarded: Boolean(row.forwarded),
      sentAt: toIsoString(row.createdAt),
      editedAt: row.editedAt ? toIsoString(row.editedAt) : null,
    };
  });
  if (isTruncated) {
    truncatedOwnMessageLists.add(exported);
  }
  return exported;
}

/**
 * The conversations the member reported something in, any report status:
 *
 *  1. a `message` report on a message in a conversation they are part of;
 *  2. a `member` report (by user id or profile slug) about someone they share a
 *     direct conversation with, which is where the in-thread report form files
 *     from;
 *  3. a `member` report about someone who has since erased their account,
 *     matched through the messages that erasure held for it
 *     (`erased_sender_ref`), since the counterpart's participant row and
 *     profile are gone.
 *
 * Every arm requires the member's own participant row, so nothing outside
 * their own inbox can be named.
 *
 * Fix round 1, three findings, one per arm, all aliases read back against the
 * final string character by character:
 *
 *  - EVERY arm now carries `AND NOT seatExcludedFromMailboxPredicate(...)` on
 *    `own`, the exporting member's own seat. The asymmetric block rule
 *    applies here exactly as it applies to the live REST reads: a staff
 *    member blocked, either direction, with a mailbox thread's customer
 *    loses their OWN access to that thread. Before this fix a blocked staff
 *    exporter's `reportedConversations` category was a way around that rule,
 *    since `buildReportedConversationsExport` read the thread's newest
 *    messages with no block check of its own, handing a blocked-out staff
 *    member the customer's and their colleagues' messages the REST layer
 *    already refuses them. A customer's own seat is always a `profile`
 *    identity and never matches the predicate, so this only ever removes a
 *    blocked-out staff member's own access. Task 14a: the arms now compose
 *    `staffSeatExcludedFromMailboxPredicate`, which carries this block rule
 *    and the departed-staff rule together, so a staff member who has left
 *    the business loses their own access here as well. Task 14: the arms
 *    compose `seatExcludedFromMailboxPredicate`, which adds a customer's
 *    block of the business, for the customer's seat and every staff seat.
 *  - Arm 2 (`member` report by user id or profile slug) no longer excludes
 *    every mailbox thread wholesale. It instead requires the matched
 *    `counterpart` seat's OWN identity to be `profile`: a mailbox seat's
 *    `identity_id` always names the business it speaks for, whichever human
 *    holds it, so a customer's report that happens to match a staff
 *    member's seat (their `user_id`, with the mailbox's identity) is
 *    excluded, while a STAFF member's OWN report against a harassing
 *    customer, filed from inside that same mailbox thread, keeps it: the
 *    matched counterpart there is the customer's own `profile` seat.
 *  - Arm 3 (a `member` report about someone since erased, matched through
 *    `erased_sender_ref`) now also excludes a held message whose
 *    `sender_identity_id` names a non-`profile` identity. `erased_sender_ref`
 *    is set per SENDER, spanning every conversation that holds a tied
 *    report, so a member report against an erased PERSONAL profile, P,
 *    otherwise still lists a business thread where P once held a staff
 *    seat: `held.sender_identity_id` there names the mailbox, and those
 *    rows would render under `FORMER_MEMBER_DISPLAY_NAME` besides, telling
 *    the customer P was staff.
 */
const REPORTED_CONVERSATION_IDS_SQL = `
  SELECT "own"."conversation_id" AS "conversationId"
  FROM "reports" "report"
  JOIN "messages" "reported"
    ON "reported"."id" = CASE
      WHEN "report"."subject_id" ~* '${UUID_SQL_PATTERN}'
        THEN "report"."subject_id"::uuid
    END
  JOIN "conversation_participants" "own"
    ON "own"."conversation_id" = "reported"."conversation_id"
   AND "own"."user_id" = $1
  WHERE "report"."reporter_id" = $1
    AND "report"."subject_type" = 'message'
    AND NOT ${seatExcludedFromMailboxPredicate('"own"."conversation_id"', '$1')}
  UNION
  SELECT "own"."conversation_id"
  FROM "reports" "report"
  JOIN "profiles" "reported_profile"
    ON "reported_profile"."slug" = "report"."subject_id"
    OR "reported_profile"."user_id" = CASE
      WHEN "report"."subject_id" ~* '${UUID_SQL_PATTERN}'
        THEN "report"."subject_id"::uuid
    END
  JOIN "conversation_participants" "counterpart"
    ON "counterpart"."user_id" = "reported_profile"."user_id"
  JOIN "identities" "counterpart_identity"
    ON "counterpart_identity"."id" = "counterpart"."identity_id"
   AND "counterpart_identity"."kind" = 'profile'
  JOIN "conversation_participants" "own"
    ON "own"."conversation_id" = "counterpart"."conversation_id"
   AND "own"."user_id" = $1
  JOIN "conversations" "conversation"
    ON "conversation"."id" = "own"."conversation_id"
   AND "conversation"."kind" = 'direct'
   AND "conversation"."is_official" = false
  WHERE "report"."reporter_id" = $1
    AND "report"."subject_type" = 'member'
    AND NOT ${seatExcludedFromMailboxPredicate('"own"."conversation_id"', '$1')}
  UNION
  SELECT "own"."conversation_id"
  FROM "reports" "report"
  JOIN "messages" "held"
    ON "held"."erased_sender_ref" = CASE
      WHEN "report"."subject_id" ~* '${UUID_SQL_PATTERN}'
        THEN "report"."subject_id"::uuid
    END
  JOIN "conversation_participants" "own"
    ON "own"."conversation_id" = "held"."conversation_id"
   AND "own"."user_id" = $1
  WHERE "report"."reporter_id" = $1
    AND "report"."subject_type" = 'member'
    AND NOT EXISTS (
      SELECT 1 FROM "identities" "held_identity"
      WHERE "held_identity"."id" = "held"."sender_identity_id"
        AND "held_identity"."kind" <> 'profile'
    )
    AND NOT ${seatExcludedFromMailboxPredicate('"own"."conversation_id"', '$1')}
  ORDER BY 1
`;

/**
 * `reportedConversations`: for each reported conversation, the newest messages
 * the member could see there. Mirrors what the thread itself shows them: no
 * tombstones (soft-delete filter), no moderator takedowns, nothing they hid for
 * themself, nothing at or before their "clear chat" point, and nothing posted
 * after they left a group.
 *
 * Three ceilings apply together, and the header of this file says why there has
 * to be more than the per-conversation one: at most
 * {@link REPORTED_CONVERSATIONS_EXPORT_CAP} conversations, at most
 * {@link REPORTED_CONVERSATION_MESSAGES_EXPORT_CAP} messages from any one of
 * them, and at most {@link REPORTED_CONVERSATION_TOTAL_MESSAGES_EXPORT_CAP}
 * messages across them all. The total budget is spent in the order the
 * conversations arrive (newest-reported first), so an early thread can use its
 * full per-conversation share and a later one may be cut short or dropped. Each
 * entry that was itself cut carries `truncated`, and a list cut by either
 * whole-list ceiling is reported through
 * {@link isReportedConversationListTruncated}.
 */
export async function buildReportedConversationsExport(
  manager: EntityManager,
  userId: string,
  identities: ExportIdentities,
): Promise<ExportedReportedConversation[]> {
  const idRows: { conversationId: string }[] = await manager.query(
    REPORTED_CONVERSATION_IDS_SQL,
    [userId],
  );
  const allConversationIds = idRows.map((row) => row.conversationId);
  if (allConversationIds.length === 0) {
    return [];
  }
  // Sliced BEFORE the context and participant reads below, so the dropped
  // conversations cost no query either.
  const conversationIds = allConversationIds.slice(
    0,
    REPORTED_CONVERSATIONS_EXPORT_CAP,
  );
  let isListTruncated = allConversationIds.length > conversationIds.length;
  let remainingMessageBudget = REPORTED_CONVERSATION_TOTAL_MESSAGES_EXPORT_CAP;
  const [contexts, ownParticipants] = await Promise.all([
    loadConversationContexts(manager, userId, conversationIds, identities),
    manager.getRepository(ConversationParticipant).find({
      where: { conversationId: In(conversationIds), userId },
      select: { id: true, conversationId: true, clearedAt: true, leftAt: true },
    }),
  ]);
  const ownParticipantByConversation = new Map(
    ownParticipants.map((participant) => [
      participant.conversationId,
      participant,
    ]),
  );

  const readConversations: {
    conversationId: string;
    rows: MessagePageRow[];
    isTruncated: boolean;
  }[] = [];
  for (const conversationId of conversationIds) {
    const ownParticipant = ownParticipantByConversation.get(conversationId);
    if (!ownParticipant) {
      continue;
    }
    if (remainingMessageBudget <= 0) {
      // The total ceiling bound before this conversation was reached, so it and
      // everything after it is missing from the archive entirely: whole
      // conversations are absent, and each conversation that did make it in
      // stays complete. That is a truncated LIST.
      isListTruncated = true;
      break;
    }
    const perConversationCap = Math.min(
      REPORTED_CONVERSATION_MESSAGES_EXPORT_CAP,
      remainingMessageBudget,
    );
    const { rows, isTruncated } = await readNewestMessages(
      manager,
      (queryBuilder) => {
        queryBuilder
          .where('m.conversation_id = :reportedConversationId', {
            reportedConversationId: conversationId,
          })
          .andWhere(notModeratedMessagePredicate('m'))
          .andWhere(
            `NOT EXISTS (
              SELECT 1 FROM "message_hides" "mh"
              WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :hiddenForUserId
            )`,
          )
          .setParameter('messageSubjectType', MESSAGE_SUBJECT_TYPE)
          .setParameter('hiddenForUserId', userId);
        if (ownParticipant.clearedAt) {
          queryBuilder.andWhere('m.created_at > :clearedAt', {
            clearedAt: ownParticipant.clearedAt.toISOString(),
          });
        }
        if (ownParticipant.leftAt) {
          queryBuilder.andWhere('m.created_at <= :leftAt', {
            leftAt: ownParticipant.leftAt.toISOString(),
          });
        }
      },
      perConversationCap,
    );
    remainingMessageBudget -= rows.length;
    readConversations.push({ conversationId, rows, isTruncated });
  }

  // Task 13f: sender resolution reuses `renderMessageSender`, the same
  // function every in-app read renders a bubble's author from, so a mailbox
  // message's sender exports as the business itself, whichever staff member
  // typed it, and an ordinary sender exports under their own name exactly as
  // before. `staffNameResolver` is a fixed no-op: this plain-string export
  // carries no per-reader staff-first-name attribution, so what it shows a
  // customer reader stays within what the app itself already showed them.
  const senderUserIds = new Set<string>([userId]);
  const senderIdentityIds = new Set<string>();
  for (const conversation of readConversations) {
    for (const row of conversation.rows) {
      if (row.senderId !== null) {
        senderUserIds.add(row.senderId);
      }
      if (row.senderIdentityId !== null) {
        senderIdentityIds.add(row.senderIdentityId);
      }
    }
  }
  const profileByUser = new Map<string, Profile>();
  for (const idChunk of chunked([...senderUserIds], ID_LOOKUP_CHUNK_SIZE)) {
    const profiles = await manager.getRepository(Profile).find({
      where: { userId: In(idChunk) },
    });
    for (const profile of profiles) {
      profileByUser.set(profile.userId, profile);
    }
  }
  const senderIdentityKindById = new Map(
    (await identities.getByIds([...senderIdentityIds])).map((identity) => [
      identity.id,
      identity.kind,
    ]),
  );
  const senderIdentityDescriptionById = await identities.describeIdentities([
    ...senderIdentityIds,
  ]);
  const senderContext: SenderIdentityContext = {
    identityKindById: senderIdentityKindById,
    identityDescriptionById: senderIdentityDescriptionById,
    staffNameResolver: { resolve: () => null },
  };

  const exported = readConversations.map((conversation) => {
    const context = contexts.get(conversation.conversationId);
    return {
      conversationId: conversation.conversationId,
      conversationTitle: context?.title ?? null,
      conversationKind: context?.kind ?? null,
      truncated: conversation.isTruncated,
      messages: conversation.rows.map((row) => {
        const facts = describeAttachment(row.kind, row.attachment);
        return {
          id: row.id,
          senderDisplayName: renderMessageSender(
            row,
            profileByUser,
            senderContext,
          ).displayName,
          isOwnMessage: row.senderId === userId,
          kind: row.kind,
          body: row.body,
          attachment: facts
            ? {
                fileName: facts.fileName,
                mimeType: facts.mimeType,
                url: facts.url,
              }
            : null,
          sentAt: toIsoString(row.createdAt),
        };
      }),
    };
  });
  if (isListTruncated) {
    truncatedReportedConversationLists.add(exported);
  }
  return exported;
}

/**
 * After every contribution is built: point each own message's attachment at
 * its file under `media/` when the member also asked for `media`, and fill an
 * image's size from the bucket listing. A file past the media byte cap, or a
 * `json`-only export's listing without `media`, leaves `mediaPath` null.
 */
export function attachMessageMediaPaths(
  ownMessages: unknown,
  mediaContribution: unknown,
): void {
  if (!Array.isArray(ownMessages)) {
    return;
  }
  const fileByBareKey = new Map<string, { name: string; sizeBytes: number }>();
  const files =
    typeof mediaContribution === 'object' &&
    mediaContribution !== null &&
    Array.isArray((mediaContribution as { files?: unknown }).files)
      ? (mediaContribution as { files: unknown[] }).files
      : [];
  for (const file of files) {
    const candidate = file as {
      name?: unknown;
      storageKey?: unknown;
      sizeBytes?: unknown;
    };
    if (
      typeof candidate.name === 'string' &&
      typeof candidate.storageKey === 'string'
    ) {
      fileByBareKey.set(toBareKey(candidate.storageKey), {
        name: candidate.name,
        sizeBytes:
          typeof candidate.sizeBytes === 'number' ? candidate.sizeBytes : 0,
      });
    }
  }
  for (const message of ownMessages as ExportedOwnMessage[]) {
    const attachment = message.attachment;
    if (!attachment) {
      continue;
    }
    const storageKey = storageKeyByExportedAttachment.get(attachment);
    const file = storageKey ? fileByBareKey.get(toBareKey(storageKey)) : null;
    if (!file) {
      continue;
    }
    attachment.mediaPath = file.name;
    if (attachment.sizeBytes === null) {
      attachment.sizeBytes = file.sizeBytes;
    }
  }
}
