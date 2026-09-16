/** Shared limits used by more than one of the split messaging services. */

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
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
