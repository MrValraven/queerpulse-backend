import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { ContentModerationState } from '../content-moderation/content-moderation.service';
import { MagazineReaderComment } from './entities/magazine-reader-comment.entity';

export interface ReaderCommentAuthor {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

const UNKNOWN_AUTHOR: ReaderCommentAuthor = {
  handle: '',
  displayName: 'Member',
  avatarUrl: null,
};

// Author identity hidden on a tombstoned/moderated comment — the frontend
// branches on `deleted` and renders its own "[deleted]" label.
const DELETED_AUTHOR: ReaderCommentAuthor = {
  handle: '',
  displayName: '',
  avatarUrl: null,
};

function toReaderCommentAuthor(
  ref: MemberRef | null | undefined,
): ReaderCommentAuthor {
  if (!ref) return UNKNOWN_AUTHOR;
  return {
    handle: ref.slug,
    displayName: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: toImageUrl(ref.avatarUrl),
  };
}

export interface ReaderCommentResponse {
  id: string;
  articleId: string;
  parentId: string | null;
  author: ReaderCommentAuthor;
  body: string;
  createdAt: string;
  editedAt: string | null;
  // True whenever the row is blanked: author tombstone, moderation removal,
  // or moderation hide. Every blanked row renders through the frontend's
  // existing tombstone branch, so a hidden comment can never surface as an
  // empty card with live Reply and Report buttons.
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
  // Only ever populated on a top-level comment (`parentId === null`); a
  // reply's `replies` is always `[]` — one level deep only.
  replies: ReaderCommentResponse[];
}

/**
 * Maps one `MagazineReaderComment` row. Unlike `toForumPostResponse`, there
 * is no moderator-viewer branch: a reader comment has no staff-facing read
 * path of its own (takedown happens entirely through the Report → mod-queue
 * pipeline, which reads `content_moderation` directly), so `canEdit`/
 * `canDelete` are simple author-ownership checks.
 */
export function toReaderCommentResponse(
  comment: MagazineReaderComment,
  author: MemberRef | null,
  viewerId: string,
  moderation: ContentModerationState,
  replies: ReaderCommentResponse[] = [],
): ReaderCommentResponse {
  const authorTombstoned = comment.deletedAt != null;
  const blanked = authorTombstoned || moderation.removed || moderation.hidden;
  const isAuthor = comment.authorId === viewerId;
  return {
    id: comment.id,
    articleId: comment.articleId,
    parentId: comment.parentId,
    author: blanked ? DELETED_AUTHOR : toReaderCommentAuthor(author),
    body: blanked ? '' : comment.body,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    // Kept in lockstep with `blanked`. Splitting the two (hidden blanked the
    // row but left `deleted` false) produced a ghost card: no author, no
    // body, and the actions still live.
    deleted: blanked,
    canEdit: isAuthor && !blanked,
    canDelete: isAuthor && !blanked,
    replies,
  };
}
