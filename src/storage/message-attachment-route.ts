import { Repository, SelectQueryBuilder } from 'typeorm';
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
import {
  mailboxStaffHistoryFloorCoversPredicate,
  seatExcludedFromMailboxPredicate,
} from '../messaging/mailbox-seats';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from '../messaging/message-visibility-predicates';
import { messageAttachmentReference } from './message-attachment-reference';
import { parseStorageKey } from './storage-key';
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
): Row {
  const attachment = message.attachment;
  if (
    !attachment ||
    (message.kind !== MessageKind.Image &&
      message.kind !== MessageKind.Document) ||
    !isSentAsMailboxIdentity(message, identityKindById)
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
 * message's conversation (a left member keeps read access to history), the
 * mailbox seat rules through `seatExcludedFromMailboxPredicate` (a staff
 * seat blocked with the customer, a departed staff seat, and every seat of a
 * thread whose customer blocked the business), and the mailbox staff
 * history floor through `mailboxStaffHistoryFloorCoversPredicate`. A
 * soft-deleted message is excluded. The attachment route and the forward of
 * a referenced attachment both read it, so the two never disagree.
 *
 * Fix round N1: two more rules. A message a moderator hid or removed
 * (`notModeratedMessagePredicate`, the takedown clause every message
 * listing composes) is refused, since the thread renders it without its
 * attachment. And only a message sent as a business, persona or company
 * qualifies, the one case the readers render by reference
 * (`isSentAsMailboxIdentity`): its `sender_identity_id` is set and names no
 * `profile` identity, a deleted business included. A personal message keeps
 * the key route, with that route's suspended-uploader rule.
 */
export function viewableMessageAttachmentQuery(
  messages: Repository<Message>,
  messageId: string,
  userId: string,
): SelectQueryBuilder<Message> {
  // `message.<property>` uses entity property names so TypeORM maps them to
  // the snake_case columns; `participant.*` references the raw joined
  // table's real column names (that alias names a raw table).
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
    .andWhere(
      `NOT ${seatExcludedFromMailboxPredicate('message.conversation_id', ':userId')}`,
    )
    .andWhere(
      `NOT ${mailboxStaffHistoryFloorCoversPredicate('message.created_at', 'participant')}`,
    )
    .andWhere(notModeratedMessagePredicate('message'), {
      messageSubjectType: MESSAGE_SUBJECT_TYPE,
    })
    .andWhere('message.sender_identity_id IS NOT NULL')
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "identities" "attachment_sender_identity"
        WHERE "attachment_sender_identity"."id" = message.sender_identity_id
          AND "attachment_sender_identity"."kind" = 'profile'
      )`,
    );
}
