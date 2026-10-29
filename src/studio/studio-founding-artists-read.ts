import { EntityManager } from 'typeorm';
import { STUDIO_ARTIST_KIND_LIST_SQL } from './studio-discovery-sql';

/**
 * `$1` the persona ids (a uuid array). The ids among them that a
 * `studio_founding_artists` row names and whose persona kind is a Studio
 * artist kind.
 */
export const FOUNDING_ARTIST_IDS_SQL = `SELECT "founding"."subprofile_id"
  FROM "studio_founding_artists" "founding"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "founding"."subprofile_id"
 WHERE "founding"."subprofile_id" = ANY($1::uuid[])
   AND "persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})`;

/**
 * Studio landing v2 (contract 11.2): the founding Studio artists among the
 * given personas, in one query for a whole list or a single view. A plain
 * function over a manager, so the subprofiles module imports no Studio
 * provider. An empty list runs no query.
 */
export async function findFoundingArtistIds(
  manager: EntityManager,
  subprofileIds: readonly string[],
): Promise<Set<string>> {
  if (subprofileIds.length === 0) {
    return new Set<string>();
  }
  const rows = await manager.query<{ subprofile_id: string }[]>(
    FOUNDING_ARTIST_IDS_SQL,
    [[...subprofileIds]],
  );
  return new Set(rows.map((row) => row.subprofile_id));
}
