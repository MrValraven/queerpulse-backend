import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import {
  personaColumnsSql,
  STUDIO_ARTIST_KIND_LIST_SQL,
} from './studio-discovery-sql';
import { listenablePersonaSql } from './studio-visibility';

/*
 * Studio spotlight curation: the staff SQL. Every alias is a literal from
 * this file; member input only reaches bound parameters. Nothing here
 * selects a member column: the persona columns come from
 * `personaColumnsSql`, which leaves the owner out.
 */

/** A persona that may be placed: a Studio artist kind, linked to its member,
 *  listenable. */
export function spotlightArtistPersonaSql(personaAlias: string): string {
  const persona = `"${personaAlias}"`;
  return `(${persona}."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
    AND ${persona}."link_visibility" = '${SubprofileLinkVisibility.Linked}'
    AND ${listenablePersonaSql(personaAlias)})`;
}

/** At least one published release of the persona. `releaseAlias` names this
 *  use's own alias. */
export function publishedReleaseExistsSql(
  personaAlias: string,
  releaseAlias: string,
): string {
  const release = `"${releaseAlias}"`;
  return `EXISTS (SELECT 1 FROM "studio_releases" ${release}
     WHERE ${release}."subprofile_id" = "${personaAlias}"."id"
       AND ${release}."status" = 'published')`;
}

/** `$1` a persona id. A placement takes this before `LOCK_SPOTLIGHT_SQL`,
 *  the order a persona unlink takes its locks in, so the two never
 *  deadlock. */
export const LOCK_SPOTLIGHT_PERSONA_SQL = `SELECT 1 FROM "subprofiles" WHERE "id" = $1::uuid FOR KEY SHARE`;

export const LOCK_SPOTLIGHT_SQL =
  'LOCK TABLE "studio_spotlight_artists" IN SHARE ROW EXCLUSIVE MODE';

export const DEFER_SPOTLIGHT_POSITIONS_SQL =
  'SET CONSTRAINTS "UQ_studio_spotlight_artists_slot_position" DEFERRED';

export const SPOTLIGHT_SLOT_SUBPROFILE_CONSTRAINT =
  'UQ_studio_spotlight_artists_slot_subprofile';

/**
 * `$1` a slot or null, `$2` a spotlight id or null. Positions are ranked per
 * slot, so the wire stays 1..n after an unlink or a persona delete left a
 * gap. The curator id is never read.
 */
export const ADMIN_SPOTLIGHT_SQL = `SELECT "ranked"."id" AS "id",
       "ranked"."slot"::text AS "slot",
       CAST("ranked"."slot_rank" AS int) AS "position",
       "ranked"."note" AS "note",
       "ranked"."created_at" AS "created_at",
       ("persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
         AND ${listenablePersonaSql('persona')}
         AND ${publishedReleaseExistsSql('persona', 'listed_release')}) AS "is_listenable",
       ${personaColumnsSql('persona', 'artist')}
  FROM (
    SELECT "spotlight"."id", "spotlight"."slot", "spotlight"."subprofile_id", "spotlight"."position",
           "spotlight"."note", "spotlight"."created_at",
           ROW_NUMBER() OVER (PARTITION BY "spotlight"."slot"
                              ORDER BY "spotlight"."position" ASC, "spotlight"."id" ASC) AS "slot_rank"
      FROM "studio_spotlight_artists" "spotlight"
  ) "ranked"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "ranked"."subprofile_id"
 WHERE ($1::text IS NULL OR "ranked"."slot"::text = $1)
   AND ($2::uuid IS NULL OR "ranked"."id" = $2::uuid)
 ORDER BY "ranked"."slot" ASC, "ranked"."slot_rank" ASC`;

/**
 * `$1` a persona id. At most one row; no row means the persona does not
 * exist, which reads as `studio_spotlight_not_an_artist`.
 */
export const SPOTLIGHT_PLACEMENT_STATE_SQL = `SELECT ${spotlightArtistPersonaSql('persona')} AS "is_artist",
       ${publishedReleaseExistsSql('persona', 'placed_release')} AS "has_release",
       EXISTS (SELECT 1 FROM "studio_spotlight_artists" "placed_star"
                WHERE "placed_star"."slot" = 'new_stars' AND "placed_star"."subprofile_id" = "persona"."id") AS "is_in_new_stars",
       (SELECT CAST(COUNT(*) AS int) FROM "studio_spotlight_artists" "counted_star"
         WHERE "counted_star"."slot" = 'new_stars') AS "new_stars_count"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1::uuid`;

/**
 * `$1` slot, `$2` persona, `$3` note or null, `$4` staff. It appends after
 * the highest position in the slot, so a gap left by an unlink never
 * collides.
 */
export const INSERT_SPOTLIGHT_SQL = `INSERT INTO "studio_spotlight_artists" ("slot", "subprofile_id", "position", "note", "created_by_id")
VALUES ($1::"studio_spotlight_slot", $2::uuid,
        COALESCE((SELECT MAX("position") FROM "studio_spotlight_artists" WHERE "slot" = $1::"studio_spotlight_slot"), 0) + 1,
        $3::text, $4::uuid)
RETURNING "id"`;

export const DELETE_ARTIST_OF_THE_MONTH_SQL = `DELETE FROM "studio_spotlight_artists" WHERE "slot" = 'artist_of_the_month'`;

/** `$1` a spotlight id. The removed slot and position come back as a row. */
export const DELETE_SPOTLIGHT_SQL = `WITH "removed" AS (DELETE FROM "studio_spotlight_artists" WHERE "id" = $1::uuid RETURNING "slot", "position")
SELECT "slot"::text AS "slot", "position" FROM "removed"`;

/** `$1` a slot, `$2` the removed position. */
export const CLOSE_SPOTLIGHT_GAP_SQL = `UPDATE "studio_spotlight_artists" SET "position" = "position" - 1
 WHERE "slot" = $1::"studio_spotlight_slot" AND "position" > $2`;

/** `$1` a spotlight id, `$2` a note or null. It leaves `created_at` alone. */
export const UPDATE_SPOTLIGHT_NOTE_SQL = `WITH "changed" AS (UPDATE "studio_spotlight_artists" SET "note" = $2::text WHERE "id" = $1::uuid RETURNING "id")
SELECT "id" FROM "changed"`;

export const NEW_STAR_IDS_SQL = `SELECT "id" FROM "studio_spotlight_artists" WHERE "slot" = 'new_stars'`;

/** `$1` the ids, `$2` their new positions. */
export const REORDER_NEW_STARS_SQL = `UPDATE "studio_spotlight_artists" AS "spotlight" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("spotlight_id", "position")
 WHERE "spotlight"."id" = "ordering"."spotlight_id" AND "spotlight"."slot" = 'new_stars'`;

/** `$1` the LIKE pattern, `$2` the limit. Placeable personas with a
 *  published release, by folded display name or handle. */
export const ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL = `SELECT ${personaColumnsSql('persona', 'artist')},
       (SELECT "option_release"."title" FROM "studio_releases" "option_release"
         WHERE "option_release"."subprofile_id" = "persona"."id" AND "option_release"."status" = 'published'
         ORDER BY "option_release"."published_at" DESC NULLS LAST, "option_release"."id" DESC
         LIMIT 1) AS "latest_release_title",
       EXISTS (SELECT 1 FROM "studio_spotlight_artists" "option_month"
                WHERE "option_month"."slot" = 'artist_of_the_month' AND "option_month"."subprofile_id" = "persona"."id") AS "is_in_artist_of_the_month",
       EXISTS (SELECT 1 FROM "studio_spotlight_artists" "option_star"
                WHERE "option_star"."slot" = 'new_stars' AND "option_star"."subprofile_id" = "persona"."id") AS "is_in_new_stars"
  FROM "subprofiles" "persona"
 WHERE ${spotlightArtistPersonaSql('persona')}
   AND ${publishedReleaseExistsSql('persona', 'searched_release')}
   AND ${foldedHaystack('persona', ['display_name', 'handle'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
 ORDER BY "persona"."display_name" ASC, "persona"."id" ASC
 LIMIT $2`;
