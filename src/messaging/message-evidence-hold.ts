import { toBareKey } from '../storage/bare-key';
import { contentTypeForStorageKey } from '../storage/served-object';
import { parseStorageKey } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import {
  DocumentAttachment,
  GifAttachment,
  isDocumentAttachment,
  isStickerAttachment,
  StickerAttachment,
} from './entities/message.entity';

/**
 * PRD-361: how long a message deleted for everyone keeps its body and its
 * attachment bytes server-side before the hourly sweep purges them.
 *
 * Before this, an unsend purged the bytes on the spot and hid the report
 * affordance, so someone could send an explicit image or a doxxing screenshot,
 * delete it seconds later, and leave the recipient with nothing to report and
 * the platform with nothing to review. Thirty days covers the realistic gap
 * between receiving something and deciding to report it, and it is a bounded
 * window: the sweep purges everything once it ends unless an open or escalated
 * report still names the message.
 */
export const MESSAGE_DELETE_EVIDENCE_HOLD_DAYS = 30;

/**
 * True while a tombstone's evidence hold is still running. `null` is "no hold"
 * (a live message, a tombstone from before the hold existed, one the sweep has
 * cleaned, or an erased member's message stamped for immediate purge). `now` is
 * injectable purely for tests.
 */
export function isEvidenceHoldActive(
  attachmentPurgeAfter: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return (
    attachmentPurgeAfter instanceof Date &&
    attachmentPurgeAfter.getTime() > now.getTime()
  );
}

/** True for a key this platform stores for a message attachment. Anything
 *  else (an absolute GIF provider URL, another kind's key, a malformed string)
 *  is never handed to a delete or to a staff download. */
export function isMessageAttachmentStorageKey(key: string): boolean {
  const kindSpec = parseStorageKey(key);
  return (
    kindSpec === UPLOAD_KIND_SPECS['message-image'] ||
    kindSpec === UPLOAD_KIND_SPECS['message-document']
  );
}

/**
 * Every platform storage key a stored attachment points at, as bare keys,
 * deduplicated. An image carries `previewUrl` beside `url` (the same value
 * today, read anyway so a future separate thumbnail key is never orphaned); a
 * document has only `url`. A picked GIF holds an absolute provider URL, which
 * is filtered out.
 *
 * A sticker's `url`/`previewUrl` are also a platform storage key, minted
 * under the separate `sticker` upload kind (`UPLOAD_KIND_SPECS.sticker`).
 * `isMessageAttachmentStorageKey` only recognises the `message-image`/
 * `message-document` kinds, so that prefix check alone already keeps a
 * sticker's admin-owned, shared artwork out of this member's own
 * purge/download surfaces, with no separate `isStickerAttachment` branch
 * needed here.
 */
export function messageAttachmentStorageKeys(
  attachment:
    GifAttachment | DocumentAttachment | StickerAttachment | null | undefined,
): string[] {
  if (!attachment) {
    return [];
  }
  const references = isDocumentAttachment(attachment)
    ? [attachment.url]
    : [attachment.url, attachment.previewUrl];
  return [
    ...new Set(
      references
        .filter((value): value is string => typeof value === 'string')
        .map(toBareKey)
        .filter((key) => isMessageAttachmentStorageKey(key)),
    ),
  ];
}

/** The one key a staff download serves for an attachment: its `url`, when that
 *  is a platform message-attachment key. Never a sticker's key, for the same
 *  prefix reason `messageAttachmentStorageKeys` above documents. */
export function primaryMessageAttachmentStorageKey(
  attachment:
    GifAttachment | DocumentAttachment | StickerAttachment | null | undefined,
): string | null {
  if (!attachment || typeof attachment.url !== 'string') {
    return null;
  }
  const key = toBareKey(attachment.url);
  return isMessageAttachmentStorageKey(key) ? key : null;
}

/**
 * The display facts of an attachment a moderator needs, none of them a URL:
 * a document's original name, format and size; an image's format (derived from
 * its server-minted key extension, which is trustworthy); a sticker's own
 * label as its "name"; nulls for a GIF.
 */
export interface MessageAttachmentFacts {
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export function messageAttachmentFacts(
  attachment:
    GifAttachment | DocumentAttachment | StickerAttachment | null | undefined,
): MessageAttachmentFacts | null {
  if (!attachment) {
    return null;
  }
  // Checked before `isDocumentAttachment` (see that discriminator's own doc):
  // a sticker has no `fileName`/`contentType`/`byteSize` to fall back to, so
  // its facts come straight from the row baked at send time.
  if (isStickerAttachment(attachment)) {
    return {
      fileName: attachment.label,
      mimeType: 'image/png',
      sizeBytes: null,
    };
  }
  if (isDocumentAttachment(attachment)) {
    return {
      fileName: attachment.fileName ?? null,
      mimeType: attachment.contentType ?? null,
      sizeBytes:
        typeof attachment.byteSize === 'number' ? attachment.byteSize : null,
    };
  }
  const storageKey = primaryMessageAttachmentStorageKey(attachment);
  return {
    fileName: null,
    mimeType: storageKey ? contentTypeForStorageKey(storageKey) : null,
    sizeBytes: null,
  };
}
