import { toPlainTextExcerpt } from '../communities/community-plain-text';
import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { ForumPost } from './entities/forum-post.entity';
import { ForumPostPhoto } from './entities/forum-post-photo.entity';
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

// The displayed author for a thread whose writer posted it anonymously (see
// `ForumThread.isAnonymous`). Swapped in exactly the way `QUEERPULSE_AUTHOR`
// above is: the real `authorId` stays on the entity and on every ownership
// check, so `canEdit`, moderation, reports and the recognition signals all keep
// pointing at a real account, and only the rendered byline changes.
//
// `handle` is empty so no client can build a profile link out of it, and there
// is deliberately no `official` flag: an anonymous thread is a member's, never
// the platform's.
const ANONYMOUS_AUTHOR: AuthorSummary = {
  handle: '',
  displayName: 'Anonymous member',
  avatarUrl: null,
};

/**
 * The two thread flags that decide whose name a thread's byline carries. A
 * structural subset of `ForumThread`, so a caller hands in the whole entity (or
 * a two-column `select`) without building an intermediate object.
 *
 * It exists so the thread CARD and its OPENING POST resolve the byline through
 * one function rather than two that can drift: a thread card reading "Anonymous
 * member" whose OP underneath still carries the author's face and handle is not
 * anonymous at all.
 */
export interface ThreadByline {
  isOfficial: boolean;
  isAnonymous: boolean;
}

/**
 * THE one byline rule, for a thread and for its opening post.
 *
 * PRECEDENCE: `isOfficial` wins over `isAnonymous`. `CreateThreadDto` and
 * `ForumThreadsService.create` already make the two mutually exclusive, but
 * this mapper does not assume the database agrees: an admin can flip
 * `isOfficial` on after the fact (`ForumThreadsService.setOfficial`), and a row
 * carrying both has to render one byline rather than whichever branch happened
 * to be tested first.
 *
 * A MODERATOR STILL SEES THE REAL AUTHOR behind an anonymous byline. Anonymity
 * is a rendering decision for the room, never a gap in the record, and an
 * anonymous thread is exactly the kind that draws a report: a moderator who
 * cannot see who they are handling cannot handle it. `isOfficial` is
 * deliberately NOT bypassed the same way, because it is not a member's identity
 * being withheld but a byline the platform chose to publish under.
 */
function toThreadBylineAuthor(
  byline: ThreadByline,
  author: MemberRef | null,
  viewerIsModerator: boolean,
): AuthorSummary {
  if (byline.isOfficial) return QUEERPULSE_AUTHOR;
  if (byline.isAnonymous && !viewerIsModerator) return ANONYMOUS_AUTHOR;
  return toAuthorSummary(author);
}

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

/**
 * One photo on a forum post, resolved for display.
 *
 * `id` is the `forum_post_photo` row's uuid, or NULL for the one synthetic
 * entry `toPostPhotoViews` builds out of the legacy `forum_post.image` column.
 * That null is the whole back-compat contract in one field: a client can render
 * every photo the same way and still tell which ones are addressable rows.
 * Nothing addresses a single photo yet (the edit path replaces the whole set),
 * so nothing breaks on the null; the day something does, it will have to reckon
 * with a legacy photo that is not a row, which is the truth.
 *
 * `url` is already through `toImageUrl`, so it is a `GET /files/<key>` URL or
 * an allowed external one, never a bare storage key. A photo whose stored value
 * resolves to nothing (a cleared column, an unparseable legacy value) is left
 * OUT of the array entirely rather than carried as a null url, so a client
 * never has to render a photo that is not there.
 */
export interface ForumPostPhotoView {
  id: string | null;
  url: string;
  alt: string | null;
}

/**
 * THE one place `forum_post.image` and `forum_post_photo` are reconciled, for
 * the opening post and every reply alike.
 *
 * THE RULE: the photo ROWS are the gallery whenever a post has any; a post with
 * none falls back to its legacy `image` column, presented as a one-photo
 * gallery. So an already-published post keeps rendering exactly the photo it
 * has always rendered, with nothing backfilled and nothing migrated, and a post
 * written by the new composer renders its four. `AddForumRichComposer` left
 * that column untouched on purpose (see its docstring: a backfill would have to
 * land atomically with a read path preferring the child table) — this IS that
 * read path, and it needs no backfill because it prefers the rows only when
 * they exist.
 *
 * The two can never disagree, because no write path leaves both populated: a
 * create carrying both spellings is a 400 (`assertSinglePhotoSpelling`), and
 * any edit that sets `photos` clears `image` in the same transaction. The
 * fallback below is therefore a statement about OLD rows, not a tie-break.
 */
export function toPostPhotoViews(
  post: Pick<ForumPost, 'image'>,
  rows: ForumPostPhoto[],
): ForumPostPhotoView[] {
  const views: ForumPostPhotoView[] = [];
  if (rows.length) {
    for (const row of rows) {
      const url = toImageUrl(row.storageKey);
      if (url) views.push({ id: row.id, url, alt: row.alt });
    }
    return views;
  }
  const legacyUrl = toImageUrl(post.image);
  // `alt: null` rather than an invented string: `forum_post.image` never had an
  // alt field, so "undescribed" is the honest answer and a placeholder would be
  // worse for a screen reader than none (see `ForumPostPhoto.alt`).
  if (legacyUrl) views.push({ id: null, url: legacyUrl, alt: null });
  return views;
}

/** One answer on a poll, with the caller's own position on it. */
export interface ForumPollOptionView {
  id: string;
  label: string;
  /** The author's display order, 0-based. */
  position: number;
  /**
   * How many members picked this option, or NULL while the results are
   * withheld from this caller (see `ForumPollView.resultsVisible`). Null is the
   * server declining to say, never zero — a poll nobody has answered reports
   * `0` to a caller entitled to the count.
   */
  voteCount: number | null;
  /** Whether THIS caller picked it. Never withheld: it is their own ballot. */
  selected: boolean;
}

/**
 * The poll attached to a thread, or absent entirely (`ForumThreadResponse.poll`
 * is null) when the thread carries none.
 *
 * WHY `voteCount`/`totalVotes` ARE NULLABLE — THE RESULTS RULE. The design says
 * results show after voting, and this server ENFORCES that rather than sending
 * the counts and asking the client to hide them. A client-side hide is not a
 * secret: the numbers are in the payload, one devtools panel away, and a poll
 * on this platform can carry answers that are nobody else's business ("have you
 * been refused care", "are you out at work"). Withholding also protects the
 * poll itself, since a member who can read the tally before answering is being
 * invited to answer with the majority rather than with the truth.
 *
 * Counts are released to a caller who has voted, once the poll has CLOSED (the
 * results are the point of a finished poll, and there is no longer a ballot to
 * influence), and to a platform moderator, who cannot act on a poll they are
 * not allowed to see. The thread's own AUTHOR is deliberately NOT special-cased:
 * they can answer their own poll like anybody else, and that is the cheapest
 * honest way to see it.
 *
 * `hasVoted` and `selected` are always truthful regardless, because they are
 * facts about the caller's own ballot rather than about anybody else's.
 */
export interface ForumPollView {
  id: string;
  allowMultiple: boolean;
  /** Ordered by `position`. */
  options: ForumPollOptionView[];
  /**
   * Sum of every option's count, or null while results are withheld. On a
   * multi-choice poll this is SELECTIONS, not voters: one member picking three
   * options adds three, which is what the percentage bars are drawn against.
   */
  totalVotes: number | null;
  /** When voting shuts, or null when the poll stays open as long as the thread does. */
  closesAt: string | null;
  /** Derived, not stored: `closesAt` is set and has passed. A closed poll still READS. */
  isClosed: boolean;
  /** Whether this caller has cast a ballot. */
  hasVoted: boolean;
  /** Whether the counts above are populated rather than withheld. */
  resultsVisible: boolean;
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
  // What the thread IS: 'question', 'guide', 'proposal' or 'share', or null for
  // every thread written before the composer asked (see `ForumThread.kind`).
  // Null is "unclassified", which a card renders as no chip at all rather than
  // guessing one.
  kind: string | null;
  // The author's own warnings about what is inside, rendered in front of the
  // body so a reader can decide before reading. Always an array (never null):
  // the column is NOT NULL DEFAULT '{}', so "no warnings" is `[]` here too and
  // no render site has to branch on null.
  contentWarnings: string[];
  // Whether the BYLINE above is masked. The card needs this to stop linking
  // `author` to a profile and to label the row; it leaks nothing, because the
  // masking has already happened by the time this is set (see
  // `toThreadBylineAuthor`). A moderator sees `true` here alongside the real
  // author, which is the honest pair: the thread IS anonymous, and staff can
  // still see whose it is.
  isAnonymous: boolean;
  // A second member credited on the thread, or null for the ordinary
  // single-author case. Null as well whenever the byline is masked for this
  // viewer: anonymity hides the byline, and a byline is both names — an
  // "anonymous" thread co-credited to a named member is not anonymous.
  coAuthor: AuthorSummary | null;
  // When the thread became visible, which stops being `createdAt` the moment
  // the composer can schedule (see `ForumThread.publishedAt`). A future value
  // only ever reaches the thread's own author or a moderator; every other
  // viewer's read paths filter the row out entirely.
  publishedAt: string;
  // 'pending' / 'approved' / 'rejected', or null for the threads nobody ever
  // submitted for review, which is most of them. Null is NOT "unreviewed,
  // therefore hidden" — see `ForumThread.reviewState`.
  reviewState: string | null;
  // Whether the thread is live to the forum RIGHT NOW.
  //
  // Derived, never stored, and the one field that lets the composer's success
  // screen and an author's drafts view tell the three states apart without
  // re-implementing the gate in the client. `publishedAt` and `reviewState`
  // above already carry the raw facts; this is the conjunction the server
  // applies, so the three states read off the trio as:
  //
  //   published now     -> isPublished true
  //   scheduled         -> isPublished false, publishedAt in the future
  //   awaiting review   -> isPublished false, reviewState 'pending'
  //                        (and 'rejected' for a verdict that was no)
  //
  // Only an author or a moderator ever sees `false` here: every other viewer's
  // read paths filter an unpublished thread out of the result set entirely.
  //
  // Mirrors `ForumThreadsService.isThreadPublished` by hand rather than calling
  // it, because that module imports this one and the reverse would be a cycle.
  // A spec pins the two together.
  isPublished: boolean;
  // A community thread its author also carried out to the town square.
  crossPosted: boolean;
  // The part of the city the thread is about, or null when it is about nowhere
  // in particular.
  neighbourhood: string | null;
  // When the thread stops taking new replies, or null when it never does.
  // Enforced on the write path (`ForumPostsService.reply`), not by a job.
  closesAt: string | null;
  // 'pt', 'en' or 'both', or null for "unstated" — which is honest for every
  // thread written before the composer asked, and better than guessing from the
  // text and mislabelling every short or mixed post.
  language: string | null;
  // Derived, not stored: `closesAt` is set and has passed. The composer's
  // deadline and a moderator's lock are different facts (`isLocked` is the
  // other one), so they stay two fields and the client can say which of the two
  // closed the thread.
  isClosed: boolean;
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
  // The thread's poll, or null when it has none (which is nearly every thread).
  // Null as well on the write echoes that do not resolve one — see
  // `toForumThreadResponse`'s `poll` parameter, which those callers leave at its
  // default.
  poll: ForumPollView | null;
  // The opening post's photos, resolved and ordered, so the thread card and the
  // detail header can draw the gallery without a second request. Reconciles the
  // legacy single `forum_post.image` with the new `forum_post_photo` rows
  // through `toPostPhotoViews`, so a post holding either renders the same way.
  //
  // Empty — never partial — whenever the OP is unshowable: an author tombstone
  // or a moderator takedown blanks the photos exactly as it blanks the excerpt,
  // because a photo is content and a takedown that left the gallery standing
  // would be no takedown at all.
  opPhotos: ForumPostPhotoView[];
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
  coAuthor: MemberRef | null = null,
  opPhotoRows: ForumPostPhoto[] = [],
  poll: ForumPollView | null = null,
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
  // Whether THIS viewer sees a masked byline. Official beats anonymous (see
  // `toThreadBylineAuthor`), and a moderator is never masked, so the two are
  // folded in here once and reused by `author` and `coAuthor` rather than
  // spelled out twice and left to drift apart.
  const isBylineMasked =
    thread.isAnonymous && !thread.isOfficial && !viewer.isModerator;
  return {
    id: thread.id,
    slug: thread.slug,
    title: thread.title,
    author: toThreadBylineAuthor(thread, author, viewer.isModerator),
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
    kind: thread.kind,
    contentWarnings: thread.contentWarnings,
    isAnonymous: thread.isAnonymous,
    // Masked viewers get no co-author at all, for the reason the field's
    // docstring gives: a byline is both names.
    coAuthor:
      isBylineMasked || coAuthor == null ? null : toAuthorSummary(coAuthor),
    publishedAt: thread.publishedAt.toISOString(),
    reviewState: thread.reviewState,
    // The same two conditions `isThreadPublished` applies, in the same order:
    // the scheduled instant has arrived, and no review is outstanding (null
    // means nobody ever asked for one, which is visible).
    isPublished:
      thread.publishedAt.getTime() <= Date.now() &&
      (thread.reviewState === null || thread.reviewState === 'approved'),
    crossPosted: thread.crossPosted,
    neighbourhood: thread.neighbourhood,
    closesAt: thread.closesAt ? thread.closesAt.toISOString() : null,
    language: thread.language,
    isClosed:
      thread.closesAt != null && thread.closesAt.getTime() <= Date.now(),
    excerpt:
      opPost == null || isOpBlanked ? null : toThreadExcerpt(opPost.body),
    unreadReplyCount,
    poll,
    // Gated on the SAME `isOpBlanked` the excerpt is, for the same reason: a
    // hidden, removed or tombstoned opening post must not keep showing its
    // pictures on the card that quotes nothing from it.
    opPhotos:
      opPost == null || isOpBlanked
        ? []
        : toPostPhotoViews(opPost, opPhotoRows),
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
  // Resolved (`toImageUrl`) URL of the post's FIRST photo, or null.
  //
  // Kept for the clients that predate `photos` below, and now fed from the same
  // reconciled gallery rather than straight off `forum_post.image`: a post
  // written by the new composer therefore still answers this field with a real
  // photo instead of the null the raw column would give. For every post that
  // has only the legacy column it is byte-for-byte what it always was, since a
  // post with no photo rows resolves to exactly that column.
  //
  // Blanked alongside the body on a tombstoned/removed/hidden post — the image
  // is content, and a takedown that left the photo standing would be no
  // takedown at all.
  image: string | null;
  // Every photo on this post, in the author's order, reconciling the legacy
  // single `forum_post.image` with the `forum_post_photo` rows — see
  // `toPostPhotoViews`, which is the one place that reconciliation happens.
  // Empty on a blanked post, for the reason `image` gives.
  photos: ForumPostPhotoView[];
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

/**
 * `threadByline` is the OP's half of the anonymity contract.
 *
 * A thread's byline is masked on the CARD by `toForumThreadResponse`, but the
 * opening post is the same byline rendered a second time on the thread page, and
 * a mask that covers one and not the other is not a mask. This mapper has no
 * thread to consult, though, and every reply on the page goes through it too.
 *
 * So the thread arrives as an optional `ThreadByline` (a two-field structural
 * subset, satisfied by the entity itself) and is applied ONLY to the post whose
 * own `isOp` flag says it is the opening post. That choice is why no reply
 * mapper has to change and no call site has to ask "is this the OP?": the batch
 * mapper hands the page's one thread down, and the per-post branch inside here
 * decides which single row it applies to. Callers that map a reply, or that have
 * no thread in hand, pass nothing and get exactly today's behaviour.
 */
export function toForumPostResponse(
  post: ForumPost,
  author: MemberRef | null,
  myVote: number,
  viewer: ForumPostViewer,
  moderation?: ForumPostModeration,
  acceptedPostId: string | null = null,
  threadByline: ThreadByline | null = null,
  photoRows: ForumPostPhoto[] = [],
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
  // Resolved ONCE and read twice below, so `image` can never disagree with the
  // head of `photos` — they are the same photo described at two ages of the
  // contract.
  const photos = blanked ? [] : toPostPhotoViews(post, photoRows);
  return {
    id: post.id,
    threadId: post.threadId,
    parentPostId: post.parentPostId ?? null,
    author: blanked
      ? DELETED_AUTHOR
      : post.isOp && threadByline
        ? toThreadBylineAuthor(threadByline, author, viewer.isModerator)
        : toAuthorSummary(author),
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
    image: photos[0]?.url ?? null,
    photos,
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
