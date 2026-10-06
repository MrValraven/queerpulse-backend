import { EntityManager, Repository, SelectQueryBuilder } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import {
  DocumentAttachment,
  GifAttachment,
  isDocumentAttachment,
  Message,
  MessageKind,
  StickerAttachment,
} from '../messaging/entities/message.entity';
import { primaryMessageAttachmentStorageKey } from '../messaging/message-evidence-hold';
import { User, UserStatus } from '../users/entities/user.entity';
import { groupJoinHistoryFloorCoversPredicate } from '../messaging/group-join-history-floor';
import {
  mailboxStaffHistoryFloorCoversPredicate,
  seatExcludedFromMailboxPredicate,
} from '../messaging/mailbox-seats';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
  withinLeftAtCeilingPredicate,
} from '../messaging/message-visibility-predicates';
import { messageAttachmentReference } from './message-attachment-reference';
import { parseStorageKey, storageKeyOwnerId } from './storage-key';
import { UPLOAD_KIND_SPECS } from './upload-kinds';

// Final fix F1 (C1): which attachments are served by message, and who may
// fetch them. See `message-attachment-reference.ts` for the reference itself.

/** The row fields the helpers below read. */
export interface MessageAttachmentRow {
  id: string;
  kind: MessageKind;
  senderIdentityId?: string | null;
  attachment: GifAttachment | DocumentAttachment | StickerAttachment | null;
}

/**
 * Whether a message was sent AS a business, persona or company. A present
 * `senderIdentityId` that did not resolve counts as one: it is a former
 * business (`renderMessageSender` names it `FORMER_IDENTITY_AUTHOR` for the
 * same reason), so its attachments stay behind the reference too.
 */
export function isSentAsMailboxIdentity(
  message: Pick<MessageAttachmentRow, 'senderIdentityId'>,
  identityKindById: ReadonlyMap<string, IdentityKind>,
): boolean {
  const senderIdentityId = message.senderIdentityId;
  return (
    Boolean(senderIdentityId) &&
    identityKindById.get(senderIdentityId!) !== IdentityKind.Profile
  );
}

/**
 * The message as every read renders it: an image or document sent as a
 * business, persona or company carries its opaque reference in place of its
 * storage key (an image's `previewUrl` too, the same bytes), so the serialized
 * URL names the message alone. The rendering depends on the message alone,
 * so a customer and every staff member receive the same URL. Every other message, personal and group
 * messages, GIFs and stickers included, is returned as it came. The stored
 * row is never changed: the return value is a copy.
 */
export function withMessageAttachmentRoute<Row extends MessageAttachmentRow>(
  message: Row,
  identityKindById: ReadonlyMap<string, IdentityKind>,
  // PRD-423: an image or document in a matched Go together chat renders by
  // reference whoever sent it, since its storage key names the uploader's
  // user id, which a matched chat never hands the other members.
  options: { isMatchedChat?: boolean } = {},
): Row {
  const attachment = message.attachment;
  if (
    !attachment ||
    (message.kind !== MessageKind.Image &&
      message.kind !== MessageKind.Document) ||
    (!options.isMatchedChat &&
      !isSentAsMailboxIdentity(message, identityKindById))
  ) {
    return message;
  }
  const reference = messageAttachmentReference(message.id);
  return {
    ...message,
    attachment: isDocumentAttachment(attachment)
      ? { ...attachment, url: reference }
      : { ...attachment, url: reference, previewUrl: reference },
  };
}

/**
 * The stored storage key an image or document message's attachment route
 * serves, or `null` when the row holds none of the kind it claims. A legacy
 * `/files/<key>` value collapses to its key.
 */
export function messageAttachmentRouteStorageKey(
  message: Pick<MessageAttachmentRow, 'kind' | 'attachment'>,
): string | null {
  const storageKey = primaryMessageAttachmentStorageKey(message.attachment);
  if (!storageKey) {
    return null;
  }
  const expectedKindSpec =
    message.kind === MessageKind.Image
      ? UPLOAD_KIND_SPECS['message-image']
      : message.kind === MessageKind.Document
        ? UPLOAD_KIND_SPECS['message-document']
        : null;
  return expectedKindSpec && parseStorageKey(storageKey) === expectedKindSpec
    ? storageKey
    : null;
}

/**
 * The image or document message `messageId`, when `userId` may see it. The
 * rules are the ones every download of a message attachment applies
 * (`FilesController.isMessageAttachmentParticipant`): a seat in the
 * message's conversation (a left member keeps read access to the history
 * posted up to their `leftAt`, ENG-401), the
 * mailbox seat rules through `seatExcludedFromMailboxPredicate` (a staff
 * seat blocked with the customer, a departed staff seat, and every seat of a
 * thread whose customer blocked the business), and the mailbox staff
 * history floor through `mailboxStaffHistoryFloorCoversPredicate`. A
 * soft-deleted message is excluded. The attachment route and the forward of
 * a referenced attachment both read it, so the two never disagree.
 *
 * PRD-400: a member who took a seat in an existing group reads it from the
 * moment they joined, so a message at or before that seat's join floor
 * (`groupJoinHistoryFloorCoversPredicate`) is refused too, as the key route
 * refuses it. A member's own "clear chat" writes `cleared_at` alone and keeps
 * its access, as before.
 *
 * Fix round N1: two more rules. A message a moderator hid or removed
 * (`notModeratedMessagePredicate`, the takedown clause every message
 * listing composes) is refused, since the thread renders it without its
 * attachment. And only a message sent as a business, persona or company
 * qualifies, the one case the readers render by reference
 * (`isSentAsMailboxIdentity`): its `sender_identity_id` is set and names no
 * `profile` identity, a deleted business included. PRD-423: so does any
 * message in a matched Go together chat, which the readers render by
 * reference too. Any other personal message keeps the key route, with that
 * route's suspended-uploader rule.
 */
export function viewableMessageAttachmentQuery(
  messages: Repository<Message>,
  messageId: string,
  userId: string,
): SelectQueryBuilder<Message> {
  // `message.<property>` uses entity property names so TypeORM maps them to
  // the snake_case columns; `participant.*` references the raw joined
  // table's real column names (that alias names a raw table).
  //
  // ENG-401: the requester's `leftAt` ceiling, as every read applies it.
  const leftAtCeiling = withinLeftAtCeilingPredicate(
    'message.created_at',
    'participant',
  );
  return messages
    .createQueryBuilder('message')
    .innerJoin(
      'conversation_participants',
      'participant',
      'participant.conversation_id = message.conversationId AND participant.user_id = :userId',
      { userId },
    )
    .where('message.id = :messageId', { messageId })
    .andWhere('message.kind IN (:...attachmentKinds)', {
      attachmentKinds: [MessageKind.Image, MessageKind.Document],
    })
    .andWhere('message.deletedAt IS NULL')
    .andWhere('message.attachment IS NOT NULL')
    .andWhere(leftAtCeiling)
    .andWhere(
      `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':userId')}`,
    )
    .andWhere(
      `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`,
    )
    .andWhere(
      `NOT ${groupJoinHistoryFloorCoversPredicate('message.created_at', 'participant')}`,
    )
    .andWhere(notModeratedMessagePredicate('message'), {
      messageSubjectType: MESSAGE_SUBJECT_TYPE,
    })
    .andWhere(`(${SENT_AS_MAILBOX_IDENTITY_SQL} OR ${IN_MATCHED_CHAT_SQL})`);
}

/** The message was sent as a business, persona or company: its
 *  `sender_identity_id` is set and names no `profile` identity, a deleted
 *  business included. */
const SENT_AS_MAILBOX_IDENTITY_SQL = `(message.sender_identity_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "identities" "attachment_sender_identity"
        WHERE "attachment_sender_identity"."id" = message.sender_identity_id
          AND "attachment_sender_identity"."kind" = 'profile'
      ))`;

/** PRD-423: the message sits in a matched Go together chat, whose readers
 *  render every image and document by reference
 *  (`withMessageAttachmentRoute`'s `isMatchedChat`). The durable flag
 *  decides, with a live group link counting too, as `memberNameOptionsFor`
 *  reads it. */
const IN_MATCHED_CHAT_SQL = `EXISTS (
        SELECT 1 FROM "conversations" "attachment_matched_chat"
        WHERE "attachment_matched_chat"."id" = message.conversation_id
          AND ("attachment_matched_chat"."is_go_together_chat"
            OR "attachment_matched_chat"."event_match_group_id" IS NOT NULL)
      )`;

/**
 * PRD-423 (opaque member keys): whether the bytes of a matched Go together
 * chat attachment at `storageKey` are withheld from `viewerId` because their
 * uploader is suspended or banned. A matched chat renders a member's own
 * photo or document by reference (`withMessageAttachmentRoute`'s
 * `isMatchedChat`), so the reference route, and a forward of the reference,
 * apply the rule the key route (`GET /files/*`) applies to that member's
 * media: withheld from everyone but the uploader and platform staff. A
 * mailbox reply keeps the reference route's own rule (the business sent it,
 * and no staff member's suspension shows). `isInMatchedChat` comes from the
 * same query that found the message (`findViewableMessageAttachment`), so
 * any other conversation answers false with no read at all.
 */
export async function isMatchedChatUploaderWithheld(
  manager: Pick<EntityManager, 'findOne'>,
  input: {
    isInMatchedChat: boolean;
    storageKey: string;
    viewerId: string;
    isStaffViewer: boolean;
  },
): Promise<boolean> {
  if (!input.isInMatchedChat) return false;
  const uploaderId = storageKeyOwnerId(input.storageKey);
  if (!uploaderId || uploaderId === input.viewerId || input.isStaffViewer) {
    return false;
  }
  const uploader = await manager.findOne(User, {
    where: { id: uploaderId },
    select: { id: true, status: true },
  });
  return uploader?.status === UserStatus.Suspended;
}

/** The raw column `findViewableMessageAttachment` reads the matched chat
 *  flag from. */
const IS_IN_MATCHED_CHAT_ALIAS = 'is_in_matched_chat';

/**
 * PRD-423: the one message `query` (a `viewableMessageAttachmentQuery`)
 * finds, with whether it sits in a matched Go together chat, read in the
 * same query through the clause the viewability rule already evaluates
 * (`IN_MATCHED_CHAT_SQL`). Null when the requester may not see it.
 */
export async function findViewableMessageAttachment(
  query: SelectQueryBuilder<Message>,
): Promise<{ message: Message; isInMatchedChat: boolean } | null> {
  const { entities, raw } = await query
    .addSelect(IN_MATCHED_CHAT_SQL, IS_IN_MATCHED_CHAT_ALIAS)
    .getRawAndEntities();
  const message = entities[0];
  if (!message) return null;
  const row = raw[0] as Record<string, unknown> | undefined;
  return {
    message,
    isInMatchedChat: row?.[IS_IN_MATCHED_CHAT_ALIAS] === true,
  };
}
