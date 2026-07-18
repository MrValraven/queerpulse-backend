import { Profile } from '../users/entities/profile.entity';
import { Message } from './entities/message.entity';

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

export function toMessageView(m: Message): MessageView {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

// ── Frontend-contract shapes ─────────────────────────────────────────────
// These mirror `AuthorSummary`/`MessageResponse`/`ConversationResponse` from
// the frontend's `src/shared/contracts/contracts.ts` exactly (field names
// included — `handle`/`displayName`, not this backend's internal
// `slug`/`firstName`+`lastName`). Every messaging HTTP read path returns these
// shapes; `MessageView` above is internal only (the MESSAGE_CREATED event
// payload and `POST /messages/request`).

export interface AuthorSummary {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface MessageResponse {
  id: string;
  conversationId: string;
  body: string;
  sender: AuthorSummary;
  createdAt: string;
}

export interface ConversationResponse {
  id: string;
  type: 'dm' | 'group';
  otherParticipant: AuthorSummary | null;
  lastMessage: MessageResponse | null;
  unreadCount: number;
  updatedAt: string;
  // Backend extras beyond the frontend contract, which ignores unknown fields.
  // `isOfficial` distinguishes the org/welcome thread `type: 'group'` covers
  // coarsely; `muted` is this caller's per-conversation preference and is only
  // present where a participant row was already loaded (i.e. the list path).
  isOfficial?: boolean;
  muted?: boolean;
}

const UNKNOWN_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Member',
  avatarUrl: null,
};

function authorSummaryFrom(p: Profile): AuthorSummary {
  return {
    handle: p.slug,
    displayName: `${p.firstName} ${p.lastName}`.trim(),
    avatarUrl: p.avatarUrl,
  };
}

/** Maps a `Profile` to an `AuthorSummary`, or `null` when there isn't one. */
export function toAuthorSummary(
  p: Profile | undefined | null,
): AuthorSummary | null {
  return p ? authorSummaryFrom(p) : null;
}

/**
 * Same as `toAuthorSummary` but for call sites where the frontend contract
 * requires a non-null `AuthorSummary` (e.g. `MessageResponse.sender`). Falls
 * back to a generic placeholder in the defensive case where a sender's
 * profile can't be resolved (should not happen for an active participant).
 */
export function requireAuthorSummary(
  p: Profile | undefined | null,
): AuthorSummary {
  return p ? authorSummaryFrom(p) : UNKNOWN_AUTHOR;
}
