import { EntityManager, In, Not, SelectQueryBuilder } from 'typeorm';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import {
  DocumentAttachment,
  GifAttachment,
  isDocumentAttachment,
  Message,
  MessageKind,
} from '../messaging/entities/message.entity';
import { EXACT_CREATED_AT_SELECT } from '../messaging/message-history-cursor';
import { FORMER_MEMBER_DISPLAY_NAME } from '../messaging/message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from '../messaging/message-visibility-predicates';
import { toBareKey } from '../storage/bare-key';
import { contentTypeForStorageKey } from '../storage/served-object';
import { Profile } from '../users/entities/profile.entity';

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
   *  it, else null. Filled by `attachMessageMediaPaths`. */
  mediaPath: string | null;
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
  attachment: { fileName: string | null; mimeType: string | null } | null;
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
  body: string;
  kind: MessageKind;
  attachment: GifAttachment | DocumentAttachment | null;
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

function displayNameOf(profile: Pick<Profile, 'firstName' | 'lastName'>) {
  return `${profile.firstName} ${profile.lastName}`.trim();
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
}

/** What the archive can say about an attachment without touching storage. */
function describeAttachment(
  kind: MessageKind,
  attachment: GifAttachment | DocumentAttachment | null,
): AttachmentFacts | null {
  if (!attachment) {
    return null;
  }
  if (isDocumentAttachment(attachment)) {
    return {
      fileName: attachment.fileName || null,
      mimeType:
        attachment.contentType || contentTypeForStorageKey(attachment.url),
      sizeBytes:
        typeof attachment.byteSize === 'number' ? attachment.byteSize : null,
      storageKey: attachment.url,
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
    };
  }
  // A picked GIF: a third-party URL, no file of the member's to point at.
  return {
    fileName: null,
    mimeType: 'image/gif',
    sizeBytes: null,
    storageKey: null,
  };
}

interface ConversationContext {
  title: string | null;
  kind: ExportedConversationKind;
}

/** Title and kind for each conversation, in a few batched lookups per chunk. */
async function loadConversationContexts(
  manager: EntityManager,
  userId: string,
  conversationIds: string[],
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
    const counterparts = directConversationIds.length
      ? await manager.getRepository(ConversationParticipant).find({
          where: {
            conversationId: In(directConversationIds),
            userId: Not(userId),
          },
          select: { id: true, conversationId: true, userId: true },
        })
      : [];
    const counterpartUserIds = [
      ...new Set(counterparts.map((participant) => participant.userId)),
    ];
    const counterpartProfiles = counterpartUserIds.length
      ? await manager.getRepository(Profile).find({
          where: { userId: In(counterpartUserIds) },
          select: { userId: true, firstName: true, lastName: true },
        })
      : [];
    const nameByUserId = new Map(
      counterpartProfiles.map((profile) => [
        profile.userId,
        displayNameOf(profile),
      ]),
    );
    const counterpartNameByConversation = new Map(
      counterparts.map((participant) => [
        participant.conversationId,
        nameByUserId.get(participant.userId) || FORMER_MEMBER_DISPLAY_NAME,
      ]),
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
        // No counterpart row left means the other member erased their account.
        contexts.set(conversation.id, {
          title:
            counterpartNameByConversation.get(conversation.id) ??
            FORMER_MEMBER_DISPLAY_NAME,
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
  const contexts = await loadConversationContexts(manager, userId, [
    ...new Set(rows.map((row) => row.conversationId)),
  ]);
  const exported = rows.map((row): ExportedOwnMessage => {
    const facts = describeAttachment(row.kind, row.attachment);
    const attachment: ExportedOwnMessageAttachment | null = facts
      ? {
          fileName: facts.fileName,
          mimeType: facts.mimeType,
          sizeBytes: facts.sizeBytes,
          mediaPath: null,
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
  JOIN "conversation_participants" "own"
    ON "own"."conversation_id" = "counterpart"."conversation_id"
   AND "own"."user_id" = $1
  JOIN "conversations" "conversation"
    ON "conversation"."id" = "own"."conversation_id"
   AND "conversation"."kind" = 'direct'
   AND "conversation"."is_official" = false
  WHERE "report"."reporter_id" = $1
    AND "report"."subject_type" = 'member'
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
    loadConversationContexts(manager, userId, conversationIds),
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
      // everything after it are missing from the archive rather than merely cut
      // short. That is a truncated LIST, not a truncated entry.
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

  const senderUserIds = new Set<string>([userId]);
  for (const conversation of readConversations) {
    for (const row of conversation.rows) {
      if (row.senderId !== null) {
        senderUserIds.add(row.senderId);
      }
    }
  }
  const nameByUserId = new Map<string, string>();
  for (const idChunk of chunked([...senderUserIds], ID_LOOKUP_CHUNK_SIZE)) {
    const profiles = await manager.getRepository(Profile).find({
      where: { userId: In(idChunk) },
      select: { userId: true, firstName: true, lastName: true },
    });
    for (const profile of profiles) {
      nameByUserId.set(profile.userId, displayNameOf(profile));
    }
  }

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
          senderDisplayName:
            row.senderId === null
              ? FORMER_MEMBER_DISPLAY_NAME
              : nameByUserId.get(row.senderId) || FORMER_MEMBER_DISPLAY_NAME,
          isOwnMessage: row.senderId === userId,
          kind: row.kind,
          body: row.body,
          attachment: facts
            ? { fileName: facts.fileName, mimeType: facts.mimeType }
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
