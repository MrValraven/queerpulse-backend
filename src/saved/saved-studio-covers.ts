import { EntityManager } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { notBlockedEitherWaySql } from '../studio/studio-discovery-sql';
import { playableTrackSql } from '../studio/studio-playlist-visibility';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toSavedId } from './saved-ref.util';

/** The saved kinds whose Library card shows a cover. */
export const SAVED_KINDS_WITH_COVER: ReadonlySet<SavedKind> = new Set([
  SavedKind.StudioRelease,
  SavedKind.StudioPlaylist,
]);

/** `$1` the release ids: each release's own cover. Called with releases the
 *  viewer can hear only (the availability answer), so no gate repeats. */
export const SAVED_RELEASE_COVERS_SQL = `SELECT "release"."id"::text AS "subject_id",
       "release"."cover_key" AS "cover_key"
  FROM "studio_releases" "release"
 WHERE "release"."id" = ANY($1::uuid[])
   AND "release"."cover_key" IS NOT NULL`;

/**
 * `$1` the viewer, `$2` the playlist ids: the cover of the first entry the
 * viewer can play, the first of the four covers the playlist card shows
 * (`StudioPlaylistReadsService.coverKeysFor`): a playable track of a
 * listenable persona whose creator is clear of blocks either way with the
 * viewer. Called with playlists the viewer can open only.
 */
export const SAVED_PLAYLIST_COVERS_SQL = `SELECT DISTINCT ON ("entry"."playlist_id")
       "entry"."playlist_id"::text AS "subject_id",
       "release"."cover_key" AS "cover_key"
  FROM "studio_playlist_tracks" "entry"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "entry"."playlist_id" = ANY($2::uuid[])
   AND "release"."cover_key" IS NOT NULL
   AND ${playableTrackSql('track', 'release', 'persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'saved_cover_block')}
 ORDER BY "entry"."playlist_id", "entry"."position" ASC`;

interface CoverRow {
  subject_id: string;
  cover_key: string | null;
}

/**
 * The cover URL of every AVAILABLE saved Studio release and playlist on a
 * page, keyed by composite saved id, in at most two queries. An unavailable
 * row gets none, so a cover never says more than its "no longer available"
 * card does. No query runs for a page without such a row.
 */
export async function savedStudioCoverUrls(
  manager: EntityManager,
  rows: readonly SavedItem[],
  availableRefs: ReadonlySet<string>,
  viewerId: string,
): Promise<Map<string, string>> {
  const idsOfKind = (kind: SavedKind) =>
    rows
      .filter(
        (row) =>
          row.subjectType === kind &&
          availableRefs.has(toSavedId(row.subjectType, row.subjectId)),
      )
      .map((row) => row.subjectId);
  const releaseIds = idsOfKind(SavedKind.StudioRelease);
  const playlistIds = idsOfKind(SavedKind.StudioPlaylist);
  const readCovers = (
    sql: string,
    parameters: unknown[],
    isNeeded: boolean,
  ): Promise<CoverRow[]> =>
    isNeeded ? manager.query<CoverRow[]>(sql, parameters) : Promise.resolve([]);
  const [releaseRows, playlistRows] = await Promise.all([
    readCovers(SAVED_RELEASE_COVERS_SQL, [releaseIds], releaseIds.length > 0),
    readCovers(
      SAVED_PLAYLIST_COVERS_SQL,
      [viewerId, playlistIds],
      playlistIds.length > 0,
    ),
  ]);
  const coverUrlBySavedId = new Map<string, string>();
  const collect = (kind: SavedKind, coverRows: CoverRow[]) => {
    for (const row of coverRows) {
      const url = toImageUrl(row.cover_key);
      if (url) coverUrlBySavedId.set(toSavedId(kind, row.subject_id), url);
    }
  };
  collect(SavedKind.StudioRelease, releaseRows);
  collect(SavedKind.StudioPlaylist, playlistRows);
  return coverUrlBySavedId;
}
