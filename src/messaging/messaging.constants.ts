/** Shared limits used by more than one of the split messaging services. */

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
/**
 * ENG-405: message kinds whose Edit rewrites the attachment CAPTION. Their
 * `body` is the send-time "Photo"/"Document"/"GIF" fallback the bubble never
 * shows, so `MessagesService.editMessage` leaves it alone and saves the
 * edited text as `attachment.caption`, the field the bubble, search and
 * mentions read. A GIF is sent exactly like a photo: the fixed "GIF" body
 * plus an optional member caption. Search skips these bodies through the
 * wider `CAPTIONED_MESSAGE_KINDS` (`common/mentions.ts`), which adds the
 * sticker: `MessagesService.searchMessages` and the starred-message search
 * match all four kinds on the caption alone (the starred search also reads
 * the file name).
 */
export const CAPTION_EDIT_MESSAGE_KINDS: readonly string[] = [
  'image',
  'document',
  'gif',
];
/**
 * ENG-405: message kinds the edit endpoint refuses outright. A sticker is
 * stored with an empty `body` and no caption (its label comes from the
 * catalogue), so an edit has nothing the author wrote to change. Kept beside
 * `EDIT_WINDOW_MS` so `canEdit` (`MessagingCoreService.toMessageResponses`)
 * and the endpoint read the same list.
 */
export const UNEDITABLE_MESSAGE_KINDS: readonly string[] = ['sticker'];
/**
 * The longest attachment caption: generous for a genuine WhatsApp-style
 * caption, tight enough that a pathological value cannot bloat every
 * response and broadcast that echoes it back. The one source for
 * `MessagingCoreService.sanitizeAttachmentCaption`'s bound (which also runs
 * on wire values that bypass the DTO in unit tests) and for a caption edit
 * (ENG-405), so an edit can never store a longer caption than a send could.
 * `GifAttachmentDto.caption`'s `@MaxLength(1000)` enforces the same value at
 * the send transport boundary.
 */
export const MAX_ATTACHMENT_CAPTION_LENGTH = 1000;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
/** Ceiling for the (unpaginated) pinned-messages banner — newest pins first. */
export const MAX_PINNED_MESSAGES = 50;
/** Ceiling for one page of the conversation media gallery (PRD-373), shared by
 *  `ListConversationMediaQuery`'s `@Max` and `ConversationMediaService`'s clamp. */
export const MAX_CONVERSATION_MEDIA_LIMIT = 50;
/**
 * Ceiling on ACTIVE (not-left) members a group may hold at once (messaging
 * scan section 8, ENG-239). Enforced in `GroupsService` at create, add, invite
 * accept and link join time, counting only active rows; a pending invite
 * counts toward this cap at ACCEPT time, not at invite time, so an owner may
 * queue more invites than remaining seats without the invite itself failing.
 * The per-request DTO cap (how many members one `POST :id/members` call may
 * name) stays 50, independent of this ceiling.
 */
export const MAX_GROUP_MEMBERS = 256;
/**
 * PRD-400: how long a group's join-by-link token stays valid after it is
 * issued or rotated (`GroupsService.createOrRotateInviteLink`). The preview
 * and join routes refuse a token past `Conversation.inviteTokenExpiresAt`
 * with `INVITE_LINK_EXPIRED`; an owner or admin re-issues it from the
 * invite-link panel. Seven days, the owner's decision of 2026-09-29.
 */
export const GROUP_INVITE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
