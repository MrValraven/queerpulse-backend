import { UUID_SEGMENT } from './storage-key';

// Final fix F1 (C1): the opaque name of one message's attachment,
// `messages/<messageId>/<attachmentIndex>`. A storage key carries its
// uploader's user id (`<prefix>/<ownerUserId>/<uuid><ext>`), so every read
// renders a photo or document sent AS a business, persona or company by this
// reference in place of its key. `toImageUrl` turns it into
// `<apiBaseUrl>/files/messages/<messageId>/<attachmentIndex>`, and
// `FilesController` serves the bytes after authorizing the requester against
// that one message. The reference names the message alone, and it is the
// same for every viewer.
//
// A message holds one attachment today, so the only index is 0. The index
// keeps the route stable for a message that one day carries several.

export const MESSAGE_ATTACHMENT_ROUTE_SEGMENT = 'messages';

export const PRIMARY_MESSAGE_ATTACHMENT_INDEX = 0;

const MESSAGE_ATTACHMENT_REFERENCE_PATTERN = new RegExp(
  `^${MESSAGE_ATTACHMENT_ROUTE_SEGMENT}/(${UUID_SEGMENT})/(${PRIMARY_MESSAGE_ATTACHMENT_INDEX})$`,
);

/** The opaque reference of `messageId`'s attachment. */
export function messageAttachmentReference(messageId: string): string {
  return `${MESSAGE_ATTACHMENT_ROUTE_SEGMENT}/${messageId}/${PRIMARY_MESSAGE_ATTACHMENT_INDEX}`;
}

/**
 * The message and attachment index a reference names, or `null` when the
 * value is not a well-formed reference. The anchored pattern admits only a
 * uuid and a known index, so a traversal or probe string never parses.
 */
export function parseMessageAttachmentReference(
  value: string,
): { messageId: string; attachmentIndex: number } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = MESSAGE_ATTACHMENT_REFERENCE_PATTERN.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { messageId: match[1], attachmentIndex: Number(match[2]) };
}

/** Whether a value is an opaque message attachment reference. */
export function isMessageAttachmentReference(value: string): boolean {
  return parseMessageAttachmentReference(value) !== null;
}
