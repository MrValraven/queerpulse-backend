// The SQL expressions the forum's block and mute filters compare a member
// against, shared by `ForumThreadsService` and `ForumPostsService` so neither
// service imports the other for them.

/**
 * The thread author column the block and mute filters compare against
 * (`BlockFilterService.excludeHidden`), as a SQL expression on the alias `t`.
 *
 * Coordinator ruling (the SEC-02 class): on an anonymous, non-official
 * thread the author is hidden, so a viewer's block or mute of that member
 * must not change what the viewer sees. A thread missing from the list, or a
 * 404 on it, would confirm who wrote it. The expression is NULL there, and a
 * NULL member column passes both filters. Every other thread keeps its
 * author's block and mute filtering exactly as before. Applied for every
 * viewer: a moderator sees the real author on the thread itself, so nothing
 * is hidden from them by listing the thread.
 */
export const THREAD_AUTHOR_FILTER_COLUMN_SQL = `CASE WHEN "t"."is_anonymous" AND NOT "t"."is_official" THEN NULL ELSE "t"."author_id" END`;

/**
 * The post author column the block and mute filters compare against
 * (`BlockFilterService.excludeHidden`), as a SQL expression on the alias `p`.
 * NULL for a post by the hidden author of an anonymous, non-official thread
 * (the opening post and their masked replies), so a viewer's block or mute
 * of that member does not drop them and thereby confirm who wrote the thread
 * (coordinator ruling, the SEC-02 class). A NULL member column passes both
 * filters. Every named post keeps its author's filtering exactly as before.
 */
export const POST_AUTHOR_FILTER_COLUMN_SQL = `CASE WHEN EXISTS (
    SELECT 1 FROM "forum_thread" "masked_thread"
    WHERE "masked_thread"."id" = "p"."thread_id"
      AND "masked_thread"."is_anonymous"
      AND NOT "masked_thread"."is_official"
      AND "masked_thread"."author_id" = "p"."author_id"
  ) THEN NULL ELSE "p"."author_id" END`;
