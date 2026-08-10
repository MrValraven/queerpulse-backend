import { ArticleBlock } from './entities/magazine-article.entity';
import { MagazineArticleVersion } from './entities/magazine-article-version.entity';

/**
 * One row of the VersionsRail list (Magazine Desk Phase 7, Task E1) —
 * deliberately light: NO `blocks` payload, so listing a long version history
 * never ships every snapshot's full content over the wire. `author` is a
 * resolved display name (editor directory ∪ Profile, exactly like
 * `ArticleCommentResponse.author`), NEVER a raw `authorId`/email.
 */
export interface ArticleVersionSummaryResponse {
  id: string;
  label: string;
  author: string;
  createdAt: string;
}

/**
 * The single-version payload for the VersionsRail diff view (Magazine Desk
 * Phase 7, Task E1) — the summary fields plus the full `blocks` snapshot, so
 * the frontend can compare it block-by-block against the article's current
 * blocks.
 */
export interface ArticleVersionDetailResponse {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  blocks: ArticleBlock[];
}

/**
 * Neutral fallback — NEVER an email or raw uuid (mirrors
 * `UNRESOLVED_COMMENT_AUTHOR_LABEL` in `magazine-article-comment-response.ts`
 * and `UNRESOLVED_ACTOR_LABEL` in `magazine-piece-response.ts`). Reached only
 * when a version's `authorId` isn't in the caller's resolved name map (or is
 * `null` — an auto-snapshot has no human actor), which is otherwise
 * defensive for any real account.
 */
export const UNRESOLVED_VERSION_AUTHOR_LABEL = 'Someone on the team';

/** Resolves a version's `authorId` (nullable) against the caller's name map. */
function resolveVersionAuthorName(
  authorId: string | null,
  authorNameById: Map<string, string>,
): string {
  if (authorId === null) {
    return UNRESOLVED_VERSION_AUTHOR_LABEL;
  }
  return authorNameById.get(authorId) ?? UNRESOLVED_VERSION_AUTHOR_LABEL;
}

/**
 * Pure mapper from a persisted `MagazineArticleVersion` to the light list
 * shape — omits `blocks` entirely (see the interface doc comment).
 */
export function toArticleVersionSummary(
  version: MagazineArticleVersion,
  authorNameById: Map<string, string>,
): ArticleVersionSummaryResponse {
  return {
    id: version.id,
    label: version.label,
    author: resolveVersionAuthorName(version.authorId, authorNameById),
    createdAt: version.createdAt.toISOString(),
  };
}

/**
 * Pure mapper from a persisted `MagazineArticleVersion` to the full detail
 * shape (used by `getArticleVersion` for the diff view) — the same fields as
 * the summary plus the `blocks` snapshot.
 */
export function toArticleVersionDetail(
  version: MagazineArticleVersion,
  authorNameById: Map<string, string>,
): ArticleVersionDetailResponse {
  return {
    id: version.id,
    label: version.label,
    author: resolveVersionAuthorName(version.authorId, authorNameById),
    createdAt: version.createdAt.toISOString(),
    blocks: version.blocks,
  };
}
