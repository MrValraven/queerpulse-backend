import { toPlainTextExcerpt } from '../communities/community-plain-text';
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
  // Optional — only a `ForumThreadResponse.author` ever carries this (a
  // thread an admin posted as "QueerPulse Official"; see `isOfficial` below).
  // Absent/`undefined` everywhere else (post/reply authors, edit-history
  // editors), so it's never mistaken for a general-purpose author field.
  official?: boolean;
}

const UNKNOWN_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Member',
  avatarUrl: null,
};

// The displayed author for a thread with `isOfficial: true` — swapped in by
// `toForumThreadResponse` instead of the real poster's `AuthorSummary`. The
// real `authorId` is left untouched on the entity (audit trail + ownership
// checks), this only changes what's rendered.
const QUEERPULSE_AUTHOR: AuthorSummary = {
  handle: 'queerpulse',
  displayName: 'QueerPulse',
  avatarUrl: null,
  official: true,
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
  // Optional moderator note explaining why the thread was locked (see
  // `ForumThread.lockReason`). Null when the current lock (or the thread's
  // unlocked state) carries no note.
  lockReason: string | null;
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
  // Whether the viewer may pin/unpin this thread — a plain moderator check,
  // same shape as `canLock`.
  canPin: boolean;
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
  // Whether the viewer may replace this thread's tag set. The author always
  // may; a platform moderator may too, so an untagged or mis-tagged thread can
  // be filed correctly without going through the author. Deliberately WIDER
  // than `canEdit` (the title), which stays author-only — a moderator
  // rewriting someone's title is a different act from filing their thread.
  canEditTags: boolean;
  // The reply the author (or a moderator) marked as the answer, or null while
  // the question is open. Mirror of `thread.acceptedPostId`.
  acceptedPostId: string | null;
  // Whether the viewer may set or clear the accepted answer — the thread's
  // author, or a platform moderator.
  canAcceptAnswer: boolean;
  // Whether the viewer is following this thread (SOC-13). Defaults to false on
  // the echoes that don't resolve it.
  isSubscribed: boolean;
  // Whether the whole thread has been withdrawn by its author or taken down by
  // staff (PRD-160, mirror of `ForumThread.deletedAt`). Only ever `true` in a
  // platform moderator's view: every member-facing read path filters deleted
  // threads out of the result set entirely, and a direct read of one 404s.
  isDeleted: boolean;
  // A short plain-text taste of the opening post, so the forum list row and the
  // feed's forum card can show what a thread is actually about instead of a
  // title and nothing (PRD-167). HTML-stripped, whitespace-collapsed, cut on a
  // word boundary at `THREAD_EXCERPT_LENGTH` with a trailing ellipsis when the
  // body ran past it.
  //
  // Null whenever the OP has nothing showable behind it: no OP resolved on this
  // echo, an OP tombstoned by its author, or an OP a moderator hid or removed.
  // That last case is why the excerpt is worth its own guard rather than
  // reading `opPost.body` directly: the thread list never carried any of the
  // body before, so a takedown had nothing to leak through here, and this field
  // is exactly the leak it would open.
  excerpt: string | null;
  // How many replies have landed in this thread since the viewer last opened it
  // (C7/PRD-170). The forum had no unread marker of any kind: a member
  // following five threads got notifications, but the list itself gave them no
  // way to see which threads had moved, so catching up meant reopening each one
  // and scrolling for something they might already have read.
  //
  // Null, deliberately, in three cases that are all "there is no watermark to
  // count against" rather than "nothing is new": an anonymous/neutral viewer, a
  // thread the member has never opened, and the write echoes that do not
  // resolve it. Zero means the opposite thing (opened, and nothing has landed
  // since), so a card can render a badge on a positive number and nothing at
  // all on null without having to guess which it is holding.
  //
  // Counts non-deleted replies by somebody else, capped at
  // `UNREAD_REPLY_COUNT_CAP` — see
  // `ForumThreadsService.unreadReplyCountsByThread` for the query and the
  // block/mute rule it applies, which is what keeps the badge from promising a
  // reply the thread page will never draw.
  unreadReplyCount: number | null;
}

/**
 * Ceiling on `ForumThreadResponse.unreadReplyCount`. A badge is a nudge, not a
 * tally: past this the exact number tells a reader nothing they cannot get from
 * "a lot", and counting it exactly is the one part of the query that has to
 * touch every row rather than stopping early.
 */
export const UNREAD_REPLY_COUNT_CAP = 99;

// Characters of opening-post body a thread card carries. Enough to tell a
// housing ask from a health question at a glance; short enough that a list row
// stays a row. The trailing ellipsis a truncated excerpt ends on is the
// truncation marker and sits on top of this window.
const THREAD_EXCERPT_LENGTH = 180;

/**
 * The OP body as a thread card should show it: markup stripped, newlines
 * collapsed to single spaces, cut on a word boundary, ellipsis when cut.
 *
 * Stripping happens HERE, at the read boundary, rather than at the write
 * boundary this repo usually normalises plain text at (`toStoredPlainText`).
 * `forum_post.body` is the post's real, editable content and is rendered in
 * full on the thread page; rewriting it on write to suit a list row would be
 * the list row deciding what a member's post says. Only the derived excerpt is
 * flattened, and only for the surfaces that ask for one.
 *
 * Returns null for a body that strips down to nothing at all (an image-only
 * post, say), so consumers get one "there is no excerpt" value rather than an
 * empty string every render site would then have to special-case anyway.
 */
function toThreadExcerpt(body: string): string | null {
  const { text, isTruncated } = toPlainTextExcerpt(body, THREAD_EXCERPT_LENGTH);
  if (!text) return null;
  return isTruncated ? `${text}…` : text;
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
 * `toForumPostResponse`'s logic applied to the OP post (a merely
 * author-tombstoned OP is the only "blanked" case they consider);
 * `canLock`/`canPin` are plain moderator checks.
 *
 * `opModeration` is the OP's `content_moderation` state, supplied by the read
 * paths that resolve it (`ForumThreadsService.toThreadResponses` batches it for
 * a page; `resolveOp` point-loads it for the single-thread echoes). It exists
 * for ONE job: keeping a hidden or removed OP's words out of `excerpt`. Left
 * undefined by the write echoes, which either just created the OP or are
 * answering the author about their own post, and where a moderation lookup
 * would buy nothing.
 *
 * `unreadReplyCount` is supplied by the same two read paths, batched one query
 * per page (C7/PRD-170). It defaults to null, which is the honest answer for
 * every echo that does not resolve a watermark: "no unread information here",
 * never "nothing is new".
 */
export function toForumThreadResponse(
  thread: ForumThread,
  author: MemberRef | null,
  viewer: ForumThreadViewer,
  opPost: ForumPost | null = null,
  myVote = 0,
  isSubscribed = false,
  opModeration?: ForumPostModeration,
  unreadReplyCount: number | null = null,
): ForumThreadResponse {
  const opTombstoned = opPost?.deletedAt != null;
  const isThreadAuthor = thread.authorId === viewer.userId;
  const opIsAuthor = opPost != null && opPost.authorId === viewer.userId;
  const canModerateOp = opIsAuthor || viewer.isModerator;
  // Everything that makes the OP body unshowable, in one place. Mirrors
  // `toForumPostResponse`'s `blanked`: an author tombstone, a `remove_content`
  // takedown and a `hide_content` takedown all mean the same thing to a card
  // that wants a taste of the post.
  const isOpBlanked =
    opTombstoned ||
    (opModeration?.removed ?? false) ||
    (opModeration?.hidden ?? false);
  return {
    id: thread.id,
    slug: thread.slug,
    title: thread.title,
    author: thread.isOfficial ? QUEERPULSE_AUTHOR : toAuthorSummary(author),
    category: thread.category,
    isPinned: thread.isPinned,
    isLocked: thread.isLocked,
    lockReason: thread.lockReason,
    replyCount: thread.replyCount,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    canEdit: isThreadAuthor,
    canDelete: opPost != null && canModerateOp && !opTombstoned,
    // Only an author's own tombstone is restorable through the forum route.
    canRestore: opPost != null && canModerateOp && opTombstoned,
    canViewHistory: opPost != null && canModerateOp && opPost.editedAt != null,
    canLock: viewer.isModerator,
    canPin: viewer.isModerator,
    opPostId: opPost?.id ?? '',
    opVoteCount: thread.opVoteCount,
    myVote,
    tags: thread.tags,
    canEditTags: isThreadAuthor || viewer.isModerator,
    acceptedPostId: thread.acceptedPostId,
    canAcceptAnswer: isThreadAuthor || viewer.isModerator,
    isSubscribed,
    isDeleted: thread.deletedAt != null,
    excerpt:
      opPost == null || isOpBlanked ? null : toThreadExcerpt(opPost.body),
    unreadReplyCount,
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
  // Resolved (`toImageUrl`) URL of the photo attached to this post, or null.
  // Blanked alongside the body on a tombstoned/removed/hidden post — the image
  // is content, and a takedown that left the photo standing would be no
  // takedown at all.
  image: string | null;
  // Whether this post is its thread's accepted answer. Drives both the badge
  // and the server-side ordering that hoists the accepted reply to the top of
  // the replies (see `ForumPostsService.listPosts`).
  isAccepted: boolean;
  // Whether this post is the thread's genuine OPENING post (C5/ENG-130), read
  // straight off `ForumPost.isOp` rather than inferred from position.
  //
  // The thread page used to take the first post of page one AS the OP. That is
  // an assumption about ordering, and the server broke it in two ordinary
  // cases: the OP is dropped from the page when its author is muted by the
  // viewer, and again when a moderator hid it and the viewer is not staff. In
  // both, the first REPLY slid into the OP card and was rendered as the
  // question, wearing its own author, timestamps and edit affordances, while
  // disappearing from the reply list underneath. Nothing in the payload let the
  // client notice. This flag, plus `opAvailable` on the posts envelope, is what
  // lets it: a page whose first post is not `isOp` has no OP in it.
  isOp: boolean;
}

export function toForumPostResponse(
  post: ForumPost,
  author: MemberRef | null,
  myVote: number,
  viewer: ForumPostViewer,
  moderation?: ForumPostModeration,
  acceptedPostId: string | null = null,
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
    // Mirrors `ForumPostsService.assertCanRestore`, which is what actually
    // enforces it — a null `deletedById` is a legacy tombstone the author may
    // still clear.
    canRestore:
      canModerate &&
      authorTombstoned &&
      !moderationRemoved &&
      (viewer.isModerator ||
        post.deletedById == null ||
        post.deletedById === viewer.userId),
    canViewHistory: canModerate && post.editedAt != null,
    moderationRemoved,
    moderationHidden,
    image: blanked ? null : toImageUrl(post.image),
    // A tombstoned/removed post can still hold the mark (the FK only clears on
    // a HARD delete), so drop it here rather than badging an empty tombstone as
    // the answer.
    isAccepted:
      !blanked && acceptedPostId != null && acceptedPostId === post.id,
    // Deliberately NOT gated on `blanked`, unlike `isAccepted`: a tombstoned
    // opening post is still the opening post, and the thread page has to keep
    // rendering it in the OP slot as a tombstone rather than promoting a reply
    // into that slot behind it.
    isOp: post.isOp,
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
