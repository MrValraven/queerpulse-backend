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

export interface ConversationMemberView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface ConversationSummary {
  id: string;
  isOfficial: boolean;
  otherMember: ConversationMemberView | null;
  lastMessage: {
    id: string;
    senderId: string;
    body: string;
    createdAt: Date;
  } | null;
  unreadCount: number;
  muted: boolean;
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

export function toConversationMemberView(
  p: Profile | undefined,
): ConversationMemberView | null {
  if (!p) {
    return null;
  }
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    avatarUrl: p.avatarUrl,
  };
}

// ── Frontend-contract shapes ─────────────────────────────────────────────
// These mirror `AuthorSummary`/`MessageResponse`/`ConversationResponse` from
// the frontend's `src/shared/contracts/contracts.ts` exactly (field names
// included — `handle`/`displayName`, not this backend's internal
// `slug`/`firstName`+`lastName`), for the `POST /conversations`
// create-or-return endpoint. Distinct from `MessageView`/`ConversationSummary`
// above, which back the pre-existing internal endpoints.

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
