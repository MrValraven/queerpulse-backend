import { toImageUrl } from '../common/image-url';
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

// Author identity hidden on a tombstoned post. The frontend branches on the
// `deleted` flag and renders its own "[deleted]" label, so these values are
// only a safe fallback, never shown verbatim.
const DELETED_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: '',
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
    avatarUrl: toImageUrl(ref.avatarUrl),
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
  canEdit: boolean;
}

export function toForumThreadResponse(
  thread: ForumThread,
  author: MemberRef | null,
  viewerId: string,
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
    canEdit: thread.authorId === viewerId,
  };
}

export interface ForumPostViewer {
  userId: string;
  isModerator: boolean;
}

export interface ForumPostResponse {
  id: string;
  threadId: string;
  author: AuthorSummary;
  body: string;
  voteCount: number;
  myVote: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  canViewHistory: boolean;
}

export function toForumPostResponse(
  post: ForumPost,
  author: MemberRef | null,
  myVote: number,
  viewer: ForumPostViewer,
): ForumPostResponse {
  const deleted = post.deletedAt != null;
  const isAuthor = post.authorId === viewer.userId;
  const canModerate = isAuthor || viewer.isModerator;
  return {
    id: post.id,
    threadId: post.threadId,
    author: deleted ? DELETED_AUTHOR : toAuthorSummary(author),
    body: deleted ? '' : post.body,
    voteCount: post.voteCount,
    myVote,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    deleted,
    canEdit: isAuthor && !deleted, // edit is author-only
    canDelete: canModerate && !deleted,
    canRestore: canModerate && deleted,
    canViewHistory: canModerate && post.editedAt != null,
  };
}

export interface ForumPostHistoryEntry {
  id: string;
  previousBody: string;
  previousTitle: string | null;
  editor: AuthorSummary;
  createdAt: string;
}

export interface ForumPostHistoryResponse {
  revisions: ForumPostHistoryEntry[];
}

export function toForumPostHistoryEntry(
  edit: {
    id: string;
    previousBody: string;
    previousTitle: string | null;
    editorId: string | null;
    createdAt: Date;
  },
  editor: MemberRef | null,
): ForumPostHistoryEntry {
  return {
    id: edit.id,
    previousBody: edit.previousBody,
    previousTitle: edit.previousTitle,
    editor: toAuthorSummary(editor),
    createdAt: edit.createdAt.toISOString(),
  };
}
