import { foldedTextExpression } from '../connections/connection-search';
import {
  foldedHaystack,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { listenablePersonaSql } from '../studio/studio-visibility';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { UserStatus } from '../users/entities/user.entity';

/**
 * The Studio artist rule for the house lineup (design correction 5). A member
 * counts only through a persona they created (`subprofiles.user_id`) that is
 * of a Studio artist kind, linked to their profile, and listenable. The
 * public lineup shows the member, so an unlinked persona never makes anyone
 * eligible and never matches a search term: either would reveal who runs it.
 * Holding a persona as a co-owner (`subprofile_members`) does not count.
 *
 * Every alias and placeholder below is a literal from this module; member
 * input only ever arrives as a bound parameter.
 */
function artistPersonaConditionSql(
  personaAlias: string,
  userIdExpression: string,
  kindsPlaceholder: string,
): string {
  const persona = `"${personaAlias}"`;
  return `${persona}."user_id" = ${userIdExpression}
       AND ${persona}."kind"::text = ANY(${kindsPlaceholder}::text[])
       AND ${persona}."link_visibility" = '${SubprofileLinkVisibility.Linked}'
       AND ${listenablePersonaSql(personaAlias)}`;
}

/** True when the member at `userIdExpression` created a linked, listenable
 *  persona whose kind is one of `kindsPlaceholder`. */
export function studioArtistPersonaExistsSql(
  userIdExpression: string,
  kindsPlaceholder: string,
): string {
  return `EXISTS (
    SELECT 1 FROM "subprofiles" "artist_persona"
     WHERE ${artistPersonaConditionSql('artist_persona', userIdExpression, kindsPlaceholder)}
  )`;
}

/** No block either way between the staff member and the member. */
function notBlockedEitherWaySql(
  staffPlaceholder: string,
  memberColumn: string,
): string {
  return `NOT EXISTS (
    SELECT 1 FROM "blocks" "artist_block"
     WHERE ("artist_block"."blocker_id" = ${staffPlaceholder} AND "artist_block"."blocked_id" = ${memberColumn})
        OR ("artist_block"."blocked_id" = ${staffPlaceholder} AND "artist_block"."blocker_id" = ${memberColumn})
  )`;
}

/** Active members who are not the house or another system account. */
const ELIGIBLE_MEMBER_SQL = `"member"."status" = '${UserStatus.Active}'
   AND "member"."is_system" = false`;

/** The search term, folded on both sides: the member's name and slug, or the
 *  display name and handle of a persona that passes the same artist rule. */
const TERM_MATCH_SQL = `(
       ${foldedHaystack('profile', PROFILE_NAME_SEARCH_COLUMNS)} LIKE ${foldedTextExpression('$1::text')} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM "subprofiles" "matched_persona"
       WHERE ${artistPersonaConditionSql('matched_persona', '"member"."id"', '$3')}
         AND ${foldedHaystack('matched_persona', ['display_name', 'handle'])} LIKE ${foldedTextExpression('$1::text')} ESCAPE '\\'
    )
  )`;

/** `$1` the like term or null, `$2` the staff member, `$3` the artist kinds.
 *  Shared by the page and its count, so both read the same rows. */
const STUDIO_ARTIST_SEARCH_FROM_SQL = `FROM "users" "member"
  JOIN "profiles" "profile" ON "profile"."user_id" = "member"."id"
 WHERE ${ELIGIBLE_MEMBER_SQL}
   AND ${studioArtistPersonaExistsSql('"member"."id"', '$3')}
   AND ${notBlockedEitherWaySql('$2::uuid', '"member"."id"')}
   AND ($1::text IS NULL OR ${TERM_MATCH_SQL})`;

/** `$1` the like term or null, `$2` the staff member, `$3` the artist kinds,
 *  `$4` the limit, `$5` the offset. One `user_id` row per member, by first
 *  name, last name, then id. */
export const STUDIO_ARTIST_SEARCH_SQL = `SELECT "member"."id" AS "user_id"
  ${STUDIO_ARTIST_SEARCH_FROM_SQL}
 ORDER BY "profile"."first_name" ASC, "profile"."last_name" ASC, "member"."id" ASC
 LIMIT $4 OFFSET $5`;

/** `$1`, `$2` and `$3` as for `STUDIO_ARTIST_SEARCH_SQL`. One row: `total`. */
export const STUDIO_ARTIST_SEARCH_COUNT_SQL = `SELECT count(*)::int AS "total"
  ${STUDIO_ARTIST_SEARCH_FROM_SQL}`;

/** `$1` the member ids, `$2` the artist kinds. The linked, listenable artist
 *  personas each member created, by display name then id. */
export const STUDIO_ARTIST_PERSONAS_SQL = `SELECT "artist_persona"."id", "artist_persona"."user_id", "artist_persona"."handle",
       "artist_persona"."display_name", "artist_persona"."kind"::text AS "kind"
  FROM "subprofiles" "artist_persona"
 WHERE "artist_persona"."user_id" = ANY($1::uuid[])
   AND "artist_persona"."kind"::text = ANY($2::text[])
   AND "artist_persona"."link_visibility" = '${SubprofileLinkVisibility.Linked}'
   AND ${listenablePersonaSql('artist_persona')}
 ORDER BY "artist_persona"."display_name" ASC, "artist_persona"."id" ASC`;

/** `$1` the performer, `$2` the staff member, `$3` the artist kinds. One row
 *  when the performer exists: whether they pass the search's artist rule,
 *  and whether a block stands either way with the staff member. */
export const STUDIO_ARTIST_BOOKABLE_SQL = `SELECT (
         ${ELIGIBLE_MEMBER_SQL}
         AND ${studioArtistPersonaExistsSql('"member"."id"', '$3')}
       ) AS "is_studio_artist",
       NOT ${notBlockedEitherWaySql('$2::uuid', '"member"."id"')} AS "is_blocked"
  FROM "users" "member"
 WHERE "member"."id" = $1::uuid`;
