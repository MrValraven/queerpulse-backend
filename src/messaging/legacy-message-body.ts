import { MessageKind } from './entities/message.entity';

/**
 * Read-time guards for two classes of legacy chat rows. The product owner
 * chose to leave the stored rows as they are, so every member-facing reader
 * (the thread, the inbox preview, the starred list, the reply quote) cleans
 * them here, and `MessagingCoreService.postMessage` stops a send from
 * writing new ones. Moderation evidence and the owner's own data export
 * keep the raw rows.
 *
 * 1. A raw translation key stored as an attachment body. The frontend sends
 *    its translated "Photo"/"File" fallback as the `body` of a photo, GIF or
 *    document, and the translator returned the key itself while that key was
 *    missing or its namespace had not loaded. Those rows show the key in the
 *    inbox and the starred list, and a forward copied it into new rows.
 * 2. A sticker edited before stickers became uneditable (ENG-405). The edit
 *    wrote text into `body` and set `edited_at`; a sticker stores an empty
 *    `body` and has nothing a member wrote, so both are dropped on read.
 */

/**
 * The two catalog keys a send could store as a photo, GIF or document
 * `body`: the image key (photos, and GIFs on some clients) and the document
 * key.
 */
export const RAW_ATTACHMENT_FALLBACK_KEYS: readonly string[] = Object.freeze([
  'messages:attachments.fallbackText',
  'messages:attachments.documentFallbackText',
]);

/**
 * The English label each attachment kind reads as when its stored `body` is
 * a raw key. The server does not know the reader's language, so it hands
 * back English and the client localizes the kind label itself.
 */
const ENGLISH_FALLBACK_LABEL_BY_KIND: ReadonlyMap<MessageKind, string> =
  new Map([
    [MessageKind.Image, 'Photo'],
    [MessageKind.Document, 'File'],
    [MessageKind.Gif, 'GIF'],
  ]);

/**
 * The `body` a member-facing reader shows for a stored message. A sticker
 * always reads as '' (a legacy edit's text is dropped). A photo, document
 * or GIF whose `body` is a raw catalog key reads as its English fallback
 * label. Every other body passes through unchanged.
 */
export function readableMessageBody(kind: MessageKind, body: string): string {
  if (kind === MessageKind.Sticker) {
    return '';
  }
  const englishLabel = ENGLISH_FALLBACK_LABEL_BY_KIND.get(kind);
  if (
    englishLabel !== undefined &&
    RAW_ATTACHMENT_FALLBACK_KEYS.includes(body)
  ) {
    return englishLabel;
  }
  return body;
}

/**
 * The `editedAt` a member-facing reader shows for a stored message, as an
 * ISO string or null. A sticker reads as never edited, so a legacy sticker
 * edit leaves no stray "edited" marker; every other kind keeps its own
 * timestamp.
 */
export function readableMessageEditedAt(
  kind: MessageKind,
  editedAt: Date | null,
): string | null {
  if (kind === MessageKind.Sticker || !editedAt) {
    return null;
  }
  return editedAt.toISOString();
}
