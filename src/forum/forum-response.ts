import { MemberRef } from '../common/member-ref';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';

// ── Frontend-contract shapes ─────────────────────────────────────────────
// Mirror `AuthorSummary`/`ForumThreadResponse`/`ForumPostResponse` from
// `queerpulse/src/shared/contracts/contracts.ts` field-for-field (`handle`/
// `displayName`, not this backend's internal `slug`/`firstName`+`lastName`).
// Kept local to `forum` (not `src/common`) since no shared `AuthorSummary`
// mapper exists yet — `src/messaging/message-response.ts` defines an
// identically-shaped one for its own contract-facing endpoints.

export interface AuthorSummary {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

const UNKNOWN_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Member',
  avatarUrl: null,
};

/**
 * Maps a `MemberRef` (from `common/member-ref.ts`'s `MemberLookup`) to an
 * `AuthorSummary`. Falls back to a generic placeholder in the defensive case
 * where an author's profile can't be resolved — `ForumThreadResponse.author`/
 * `ForumPostResponse.author` are non-nullable in `contracts.ts`, so callers
 * always get a well-formed object rather than `null`.
 */
export function toAuthorSummary(
  ref: MemberRef | null | undefined,
): AuthorSummary {
  if (!ref) return UNKNOWN_AUTHOR;
  return {
    handle: ref.slug,
    displayName: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

export interface ForumThreadResponse {
  id: string;
  slug: string;
  title: string;
  author: AuthorSummary;
  category: string;
  isPinned: boolean;
  isLocked: boolean;
  replyCount: number;
  lastActivityAt: string;
  createdAt: string;
}

export function toForumThreadResponse(
  thread: ForumThread,
  author: MemberRef | null,
): ForumThreadResponse {
  return {
    id: thread.id,
    slug: thread.slug,
    title: thread.title,
    author: toAuthorSummary(author),
    category: thread.category,
    isPinned: thread.isPinned,
    isLocked: thread.isLocked,
    replyCount: thread.replyCount,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
  };
}

export interface ForumPostResponse {
  id: string;
  threadId: string;
  author: AuthorSummary;
  body: string;
  voteCount: number;
  myVote: number;
  createdAt: string;
}

export function toForumPostResponse(
  post: ForumPost,
  author: MemberRef | null,
  myVote: number,
): ForumPostResponse {
  return {
    id: post.id,
    threadId: post.threadId,
    author: toAuthorSummary(author),
    body: post.body,
    voteCount: post.voteCount,
    myVote,
    createdAt: post.createdAt.toISOString(),
  };
}
