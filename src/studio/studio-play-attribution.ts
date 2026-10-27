/**
 * Attribution is computed from the current credits at read time. A credit
 * accepted later picks up every earlier play of the track, a credit removed
 * later takes those plays off, and the milestones already written stay.
 * `UNION` (without `ALL`) counts a persona credited in two roles once.
 */

/**
 * The personas a track is attributed to: the persona that owns its release
 * plus every persona with an accepted credit on it. Parenthesised, column
 * `artist_id`; use it as `CROSS JOIN LATERAL ${...} "attributed"` or after
 * `IN`. `trackAlias` is the alias of a `studio_tracks` row in the outer query.
 */
export function studioTrackArtistIdsSql(trackAlias: string): string {
  return `(
    SELECT "attributed_release"."subprofile_id" AS "artist_id"
    FROM "studio_releases" "attributed_release"
    WHERE "attributed_release"."id" = "${trackAlias}"."release_id"
    UNION
    SELECT "attributed_credit"."subprofile_id" AS "artist_id"
    FROM "studio_persona_credits" "attributed_credit"
    WHERE "attributed_credit"."track_id" = "${trackAlias}"."id"
      AND "attributed_credit"."status" = 'accepted'
  )`;
}

/**
 * The tracks attributed to one persona: the tracks of its own releases plus
 * the tracks it holds an accepted credit on. Parenthesised, column
 * `track_id`. `personaExpression` is spliced verbatim twice (a quoted column
 * or `$n`).
 */
export function studioPersonaTrackIdsSql(personaExpression: string): string {
  return `(
    SELECT "own_track"."id" AS "track_id"
    FROM "studio_tracks" "own_track"
    INNER JOIN "studio_releases" "own_release"
      ON "own_release"."id" = "own_track"."release_id"
    WHERE "own_release"."subprofile_id" = ${personaExpression}
    UNION
    SELECT "credited"."track_id" AS "track_id"
    FROM "studio_persona_credits" "credited"
    WHERE "credited"."subprofile_id" = ${personaExpression}
      AND "credited"."status" = 'accepted'
  )`;
}
