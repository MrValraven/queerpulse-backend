import { gatedAccessTiersSqlLiteralList } from '../communities/community-gate';
import {
  ownRosterRowCountsSql,
  parentStaffOfSpaceSql,
} from '../communities/subcommunity-rules';
import {
  forumOpNotTakenDownSql,
  forumThreadVisibleSql,
} from './forum-threads.service';

// The roster helpers in `subcommunity-rules` take a bound parameter NAME and
// write `:<name>` into their SQL. This predicate runs inside raw `query()`
// calls numbered `$1`, `$2` and so on, where a named parameter would never be
// bound, so each helper is called with this placeholder and every
// `:<placeholder>` is then swapped for the saver's own user id column.
const SAVER_USER_ID_PLACEHOLDER = 'fundingSaverUserId';

// The tiers whose content is closed to anyone off the roster, rendered from
// the shared `GATED_ACCESS_TIERS` that `ForumThreadsService` also reads, so a
// tier added later is gated here too. Enum values only, so inlining them as
// SQL literals is safe and adds no bind parameter.
const GATED_ACCESS_TIERS_SQL = gatedAccessTiersSqlLiteralList();

function withSaverUserIdColumn(
  helperSql: string,
  saverUserIdSql: string,
): string {
  return helperSql.split(`:${SAVER_USER_ID_PLACEHOLDER}`).join(saverUserIdSql);
}

/**
 * The community half of the saver gate: the SQL twin of
 * `ForumThreadsService.isCommunityHiddenFrom` as `assertVisibleOr404` applies
 * it, evaluated for the saver.
 *
 * A thread with no community, or one its author cross-posted, skips the gate.
 * Otherwise the thread is hidden only when its community is on a gated tier
 * AND the saver holds no roster row there that counts AND the saver is not
 * staff of the space's parent. So:
 * - a public community, top-level or a space, is readable to every saver;
 * - a space roster row counts only while the saver still holds the parent
 *   roster row (`ownRosterRowCountsSql`), so a leftover space row grants
 *   nothing;
 * - parent owners, co-owners and mods read every gated space of that parent
 *   with no space roster row (`parentStaffOfSpaceSql`).
 *
 * Written as the negation of that hidden test, like the read gate itself, so
 * a `community_id` whose community row is gone counts as not hidden there and
 * here alike.
 */
function fundingSaverCommunityVisibleSql(
  threadAlias: string,
  savedAlias: string,
): string {
  const saverUserIdSql = `${savedAlias}."user_id"`;
  const ownRosterRowCounts = withSaverUserIdColumn(
    ownRosterRowCountsSql('"community"."id"', SAVER_USER_ID_PLACEHOLDER),
    saverUserIdSql,
  );
  const parentStaffOfSpace = withSaverUserIdColumn(
    parentStaffOfSpaceSql('"community"."id"', SAVER_USER_ID_PLACEHOLDER),
    saverUserIdSql,
  );
  return `(
           ${threadAlias}."community_id" IS NULL
           OR ${threadAlias}."cross_posted" = true
           OR NOT EXISTS (
                SELECT 1 FROM "communities" "community"
                 WHERE "community"."id" = ${threadAlias}."community_id"
                   AND "community"."access_tier" IN (${GATED_ACCESS_TIERS_SQL})
                   AND NOT EXISTS (
                         SELECT 1 FROM "community_members" "membership"
                          WHERE "membership"."community_id" = "community"."id"
                            AND "membership"."user_id" = ${saverUserIdSql}
                            AND ${ownRosterRowCounts}
                       )
                   AND NOT ${parentStaffOfSpace}
              )
         )`;
}

/**
 * Funding & Grants (P3): the predicate that says a saved open call may still
 * reach its saver. Shared by the reminder sweeper and the deadline-changed
 * listener so both leak nothing the thread page would hide. Each clause
 * mirrors a gate the page applies: a call that is live (neither withdrawn, scheduled nor held)
 * (the shared read gate), an OP a moderator has not hidden or removed, no
 * block either way between saver and author, and the community read gate
 * for the saver (`fundingSaverCommunityVisibleSql`).
 *
 * Returns a bare boolean expression (no leading AND) over the two aliases,
 * which the caller passes already quoted, for example `'"thread"'` and
 * `'"saved"'`. It takes no bind parameters.
 */
export function fundingSaverVisibleSql(
  threadAlias: string,
  savedAlias: string,
): string {
  return `${threadAlias}."kind" = 'call'
     AND ${threadAlias}."deleted_at" IS NULL
     AND ${forumThreadVisibleSql(threadAlias)}
     AND ${forumOpNotTakenDownSql(threadAlias)}
     AND NOT EXISTS (
           SELECT 1
             FROM "blocks" "block"
            WHERE ("block"."blocker_id" = ${savedAlias}."user_id" AND "block"."blocked_id" = ${threadAlias}."author_id")
               OR ("block"."blocked_id" = ${savedAlias}."user_id" AND "block"."blocker_id" = ${threadAlias}."author_id")
         )
     AND ${fundingSaverCommunityVisibleSql(threadAlias, savedAlias)}`;
}
