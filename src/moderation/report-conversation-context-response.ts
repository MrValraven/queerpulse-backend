import { Message, MessageKind } from '../messaging/entities/message.entity';
import {
  messageAttachmentFacts,
  MessageAttachmentFacts,
} from '../messaging/message-evidence-hold';
import { MessageSnapshotEvidence } from '../reports/report-evidence';
import { Profile } from '../users/entities/profile.entity';
import type { SentAsIdentityDTO } from './sent-as-identity';

/** PRD-360: messages shown on EACH side of the reported one. */
export const CONVERSATION_CONTEXT_WINDOW_SIZE = 20;

/** Not a message report, or its message row no longer exists. */
export const CONVERSATION_CONTEXT_UNAVAILABLE_CODE =
  'CONVERSATION_CONTEXT_UNAVAILABLE';

/** The audit action written once per opening of the viewer. */
export const CONVERSATION_CONTEXT_VIEWED_AUDIT_ACTION =
  'conversation_context_viewed';

export interface ConversationContextMessageDTO {
  id: string;
  /** Null once the sender has erased their account. */
  senderId: string | null;
  /** Null exactly when `senderId` is null. */
  senderDisplayName: string | null;
  senderSlug: string | null;
  /** Business mailboxes, design section 9: the business, persona or company
   *  this message was sent as, beside the human sender above. Null for a
   *  personal message. */
  sentAsIdentity: SentAsIdentityDTO | null;
  kind: MessageKind;
  /** Null for a tombstone, except the reported message itself, which shows
   *  its retained body (or the report's snapshot of it). */
  body: string | null;
  /** Display facts only, never a URL. The reported message's bytes are
   *  served by `GET /mod/report-message-attachment/:reportId`. */
  attachment: MessageAttachmentFacts | null;
  sentAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  isReportedMessage: boolean;
}

export interface ReportConversationContextDTO {
  reportId: string;
  conversationId: string;
  reportedMessageId: string;
  /** More messages exist before the window. */
  hasEarlierMessages: boolean;
  /** More messages exist after the window. */
  hasLaterMessages: boolean;
  /** Oldest first, the reported message included. */
  messages: ConversationContextMessageDTO[];
}

/** One message of the window, hand-mapped; never the raw entity. */
export function toConversationContextMessage(
  message: Message,
  profileByUserId: Map<string, Profile>,
  reportedMessageId: string,
  reportedSnapshot: MessageSnapshotEvidence | null,
  sentAsByIdentityId: ReadonlyMap<string, SentAsIdentityDTO> = new Map(),
): ConversationContextMessageDTO {
  const isReportedMessage = message.id === reportedMessageId;
  const isDeleted = message.deletedAt !== null;
  const senderId = message.senderId ?? null;
  const profile = senderId ? profileByUserId.get(senderId) : undefined;
  const profileName = profile
    ? `${profile.firstName} ${profile.lastName}`.trim()
    : '';

  let body: string | null = message.body;
  let attachment = messageAttachmentFacts(message.attachment);
  if (isDeleted && !isReportedMessage) {
    body = null;
    attachment = null;
  } else if (isDeleted && isReportedMessage) {
    // The sweep blanks a released tombstone, and an open report stops it from
    // doing so, so the retained row normally still holds both. The snapshot is
    // the fallback for a row cleaned before the report reached it.
    body = message.body || reportedSnapshot?.body || null;
    attachment =
      attachment ??
      (reportedSnapshot?.attachment
        ? {
            fileName: reportedSnapshot.attachment.fileName,
            mimeType: reportedSnapshot.attachment.mimeType,
            sizeBytes: reportedSnapshot.attachment.sizeBytes,
          }
        : null);
  }

  return {
    id: message.id,
    senderId,
    senderDisplayName: senderId ? profileName || 'Member' : null,
    senderSlug: profile?.slug ?? null,
    sentAsIdentity: message.senderIdentityId
      ? (sentAsByIdentityId.get(message.senderIdentityId) ?? null)
      : null,
    kind: message.kind,
    body,
    attachment,
    sentAt: message.createdAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    isDeleted,
    isReportedMessage,
  };
}
