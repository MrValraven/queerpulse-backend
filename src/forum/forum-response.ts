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
  // Per-viewer moderation/lock affordances for the OP post, mirroring
  // `ForumPostResponse`'s flags so the thread-list/detail card can render the OP
  // row's moderation menu without a second post fetch. `canDelete`/`canRestore`/
  // `canViewHistory` mirror `toForumPostResponse`'s OP logic (author-or-
  // moderator; restore only when author-tombstoned; history only when edited);
  // `canLock` is true iff the viewer is a moderator. All default `false` on the
  // echoes that don't resolve the OP post or the viewer's role.
  canDelete: boolean;
  canRestore: boolean;
  canViewHistory: boolean;
  canLock: boolean;
  // Id of the thread's opening post (the oldest `ForumPost`). Lets the
  // list-row upvote button + row moderation act on the OP without a second
  // request. Empty string when the caller hasn't resolved it (e.g. a
  // create/edit echo that maps a single thread without a batch OP lookup).
  opPostId: string;
  // The OP post's vote count (mirror of `thread.opVoteCount`), driving the card
  // upvotes and the `top` sort.
  opVoteCount: number;
  // The viewer's own vote on the OP (0 or 1). Defaults to 0 until the batch
  // vote lookup resolves it (Wave 2 `toThreadResponses`).
  myVote: number;
  // Normalized (lowercase, deduped) tags for the thread — mirror of
  // `thread.tags`.
  tags: string[];
}

// The viewer of a thread card — their id plus whether they hold a moderator
// role. Mirrors `ForumPostViewer`; the OP moderation/lock flags need the role,
// not just the id.
export interface ForumThreadViewer {
  userId: string;
  isModerator: boolean;
}

/**
 * `opPost` and `myVote` are supplied by the batched list/detail mappers that
 * resolve the OP post and the viewer's vote on it in one query each. `opPost`
 * defaults to `null` (and `myVote` to 0) so any echo that doesn't resolve the
 * OP still returns a well-formed object — with the OP moderation flags off.
 *
 * The `canDelete`/`canRestore`/`canViewHistory` flags mirror
 * `toForumPostResponse`'s logic applied to the OP post (moderation-table state
 * isn't consulted on this path, so a merely author-tombstoned OP is the only
 * "blanked" case here); `canLock` is a plain moderator check.
 */
export function toForumThreadResponse(
  thread: ForumThread,
  author: MemberRef | null,
  viewer: ForumThreadViewer,
  opPost: ForumPost | null = null,
  myVote = 0,
): ForumThreadResponse {
  const opTombstoned = opPost?.deletedAt != null;
  const opIsAuthor = opPost != null && opPost.authorId === viewer.userId;
  const canModerateOp = opIsAuthor || viewer.isModerator;
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
    canEdit: thread.authorId === viewer.userId,
    canDelete: opPost != null && canModerateOp && !opTombstoned,
    // Only an author's own tombstone is restorable through the forum route.
    canRestore: opPost != null && canModerateOp && opTombstoned,
    canViewHistory: opPost != null && canModerateOp && opPost.editedAt != null,
    canLock: viewer.isModerator,
    opPostId: opPost?.id ?? '',
    opVoteCount: thread.opVoteCount,
    myVote,
    tags: thread.tags,
  };
}

export interface ForumPostViewer {
  userId: string;
  isModerator: boolean;
}

// A moderator takedown on this post, as the read path resolved it from the
// shared `content_moderation` table. Optional: callers that don't consult
// moderation state (create/vote/edit echoes) leave it undefined = untouched.
export interface ForumPostModeration {
  hidden: boolean;
  removed: boolean;
}

export interface ForumPostResponse {
  id: string;
  threadId: string;
  parentPostId: string | null;
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
  // A moderator `remove_content` takedown. Distinct from `deleted` (which also
  // covers an author's own tombstone) so staff/appeals can tell the two apart;
  // the frontend renders both as "[removed]".
  moderationRemoved: boolean;
  // A moderator `hide_content` takedown. Only ever `true` in a moderator's own
  // view — members never receive a hidden post (it is filtered out upstream).
  moderationHidden: boolean;
}

export function toForumPostResponse(
  post: ForumPost,
  author: MemberRef | null,
  myVote: number,
  viewer: ForumPostViewer,
  moderation?: ForumPostModeration,
): ForumPostResponse {
  const authorTombstoned = post.deletedAt != null;
  const moderationRemoved = moderation?.removed ?? false;
  const moderationHidden = moderation?.hidden ?? false;
  // A removed post renders exactly like an author tombstone (empty body,
  // hidden author). Hiding the body of a merely-hidden post too keeps a
  // moderator's view from leaking content a member can't see if the flag is
  // ever surfaced verbatim.
  const blanked = authorTombstoned || moderationRemoved || moderationHidden;
  const isAuthor = post.authorId === viewer.userId;
  const canModerate = isAuthor || viewer.isModerator;
  return {
    id: post.id,
    threadId: post.threadId,
    parentPostId: post.parentPostId ?? null,
    author: blanked ? DELETED_AUTHOR : toAuthorSummary(author),
    body: blanked ? '' : post.body,
    voteCount: post.voteCount,
    myVote,
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    deleted: authorTombstoned || moderationRemoved,
    canEdit: isAuthor && !blanked, // edit is author-only
    canDelete: canModerate && !blanked,
    // Only an author's own tombstone is restorable through the forum route; a
    // moderator takedown is lifted through the moderation/appeal path, not here.
    canRestore: canModerate && authorTombstoned && !moderationRemoved,
    canViewHistory: canModerate && post.editedAt != null,
    moderationRemoved,
    moderationHidden,
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
