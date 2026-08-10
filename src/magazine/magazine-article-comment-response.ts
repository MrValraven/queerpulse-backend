import { MagazineArticleComment } from './entities/magazine-article-comment.entity';

/**
 * One node of the NotesRail comment thread (Magazine Desk Phase 7, Task D1):
 * a top-level comment or a reply, hand-mapped from `MagazineArticleComment` —
 * `author` is a resolved display name (editor directory ∪ Profile, exactly
 * like `MagazinePieceService.listMagazineNotifications`), NEVER a raw
 * `authorId`/email. The shape is recursive so a caller never has to
 * special-case depth, but in practice `replies` is one level deep — a reply
 * always targets a top-level comment (see the entity's doc comment).
 */
export interface ArticleCommentResponse {
  id: string;
  blockId: string | null;
  parentId: string | null;
  author: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  replies: ArticleCommentResponse[];
}

/**
 * Neutral fallback — NEVER an email or raw uuid (mirrors
 * `magazine-piece-response.ts`'s `UNRESOLVED_ACTOR_LABEL`). Reached only when
 * a comment's `authorId` isn't in the caller's resolved name map, which
 * shouldn't happen for any real account (defensive).
 */
export const UNRESOLVED_COMMENT_AUTHOR_LABEL = 'Someone on the team';

/**
 * Pure mapper from one persisted `MagazineArticleComment` to a single
 * `ArticleCommentResponse` node with no replies attached — used by the
 * mutation endpoints (`addArticleComment`/`replyToArticleComment`/
 * `resolveArticleComment`), which each return exactly the one row they just
 * wrote. For the full nested thread, see `toArticleCommentTree`.
 */
export function toArticleCommentResponse(
  comment: MagazineArticleComment,
  authorName: string,
): ArticleCommentResponse {
  return {
    id: comment.id,
    blockId: comment.blockId,
    parentId: comment.parentId,
    author: authorName,
    body: comment.body,
    resolved: comment.resolved,
    createdAt: comment.createdAt.toISOString(),
    replies: [],
  };
}

/**
 * Pure mapper from a flat list of `MagazineArticleComment` rows (one
 * article's worth) to a nested `ArticleCommentResponse[]` tree (Magazine Desk
 * Phase 7, Task D1 NotesRail). Top-level comments (`parentId === null`) sort
 * newest-first, matching the notifications/activity convention elsewhere in
 * this module; each comment's `replies` sort oldest-first, so a thread reads
 * top-to-bottom in the order it was written. `authorNameById` is resolved by
 * the caller (a batched editor-directory ∪ Profile lookup, mirroring
 * `listMagazineNotifications`) so this stays a pure function of its inputs —
 * an author id missing from the map (defensive) falls back to
 * `UNRESOLVED_COMMENT_AUTHOR_LABEL`, never a raw id or email.
 */
export function toArticleCommentTree(
  comments: MagazineArticleComment[],
  authorNameById: Map<string, string>,
): ArticleCommentResponse[] {
  const topLevelComments: MagazineArticleComment[] = [];
  const repliesByParentId = new Map<string, MagazineArticleComment[]>();

  for (const comment of comments) {
    if (comment.parentId === null) {
      topLevelComments.push(comment);
      continue;
    }
    const siblingReplies = repliesByParentId.get(comment.parentId) ?? [];
    siblingReplies.push(comment);
    repliesByParentId.set(comment.parentId, siblingReplies);
  }

  function toNode(comment: MagazineArticleComment): ArticleCommentResponse {
    const replies = (repliesByParentId.get(comment.id) ?? [])
      .slice()
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .map(toNode);

    return {
      id: comment.id,
      blockId: comment.blockId,
      parentId: comment.parentId,
      author:
        authorNameById.get(comment.authorId) ?? UNRESOLVED_COMMENT_AUTHOR_LABEL,
      body: comment.body,
      resolved: comment.resolved,
      createdAt: comment.createdAt.toISOString(),
      replies,
    };
  }

  return topLevelComments
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .map(toNode);
}
