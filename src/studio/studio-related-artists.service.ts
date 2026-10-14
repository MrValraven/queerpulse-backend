import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  LISTENABLE_ARTIST_SQL,
  STUDIO_ARTIST_KIND_LIST_SQL,
  artistRefFromColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import {
  playableTrackAudioSql,
  publiclyListedPlaylistSql,
} from './studio-playlist-visibility';
import { StudioArtistRef } from './studio-response';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_DISCOVERY_LIMITS } from './studio.constants';

/**
 * `$1` the viewer, `$2` the artist, `$3` the limit. One query, highest score
 * first, ties by the newest listenable release, then persona id. Built from
 * public data only:
 * - accepted credits between the two personas in either direction, on
 *   published releases: 4 per credited track, capped at 12;
 * - public playlists (listed publicly: credit standing, owner granted)
 *   holding a playable track by each, counted only when those playlists
 *   come from at least 2 distinct owners: 2 per playlist, capped at 8;
 * - a published release of each in the same active scene: 2;
 * - a shared genre across published releases: 1 per genre, capped at 2.
 * Candidates are listenable personas of a Studio artist kind with a published
 * release, their creator clear of blocks with the viewer, the artist itself
 * excluded. A score of 0 is never returned.
 */
export const RELATED_ARTISTS_SQL = `WITH "candidate" AS (
  SELECT ${personaColumnsSql('persona', 'artist')},
         MAX("release"."published_at") AS "newest_published_at"
    FROM "subprofiles" "persona"
    INNER JOIN "studio_releases" "release"
       ON "release"."subprofile_id" = "persona"."id"
      AND "release"."status" = 'published'
   WHERE "persona"."id" <> $2
     AND "persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
     AND ${listenablePersonaSql('persona')}
     AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'candidate_block')}
   GROUP BY "persona"."id"
),
"credit_link" AS (
  SELECT "release"."subprofile_id" AS "other_id", "credit"."track_id" AS "track_id"
    FROM "studio_persona_credits" "credit"
    INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
    INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
   WHERE "credit"."status" = 'accepted'
     AND "release"."status" = 'published'
     AND "credit"."subprofile_id" = $2
  UNION
  SELECT "credit"."subprofile_id" AS "other_id", "credit"."track_id" AS "track_id"
    FROM "studio_persona_credits" "credit"
    INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
    INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
   WHERE "credit"."status" = 'accepted'
     AND "release"."status" = 'published'
     AND "release"."subprofile_id" = $2
),
"credit_score" AS (
  SELECT "other_id", LEAST(COUNT(DISTINCT "track_id") * 4, 12) AS "score"
    FROM "credit_link"
   GROUP BY "other_id"
),
"playlist_pair" AS (
  SELECT DISTINCT "other_release"."subprofile_id" AS "other_id",
         "playlist"."id" AS "playlist_id",
         "playlist"."user_id" AS "owner_id"
    FROM "studio_playlists" "playlist"
    INNER JOIN "studio_playlist_tracks" "artist_entry" ON "artist_entry"."playlist_id" = "playlist"."id"
    INNER JOIN "studio_tracks" "artist_track" ON "artist_track"."id" = "artist_entry"."track_id"
    INNER JOIN "studio_releases" "artist_release" ON "artist_release"."id" = "artist_track"."release_id"
    INNER JOIN "studio_playlist_tracks" "other_entry" ON "other_entry"."playlist_id" = "playlist"."id"
    INNER JOIN "studio_tracks" "other_track" ON "other_track"."id" = "other_entry"."track_id"
    INNER JOIN "studio_releases" "other_release" ON "other_release"."id" = "other_track"."release_id"
   WHERE "artist_release"."subprofile_id" = $2
     AND "other_release"."subprofile_id" <> $2
     -- The persona side of a playable track is checked on the candidate
     -- ("candidate") and on the artist (the 404 check).
     AND (${playableTrackAudioSql('artist_track', 'artist_release')})
     AND (${playableTrackAudioSql('other_track', 'other_release')})
     AND ${publiclyListedPlaylistSql('playlist')}
),
"playlist_score" AS (
  SELECT "other_id", LEAST(COUNT(*) * 2, 8) AS "score"
    FROM "playlist_pair"
   GROUP BY "other_id"
  HAVING COUNT(DISTINCT "owner_id") >= 2
),
"scene_score" AS (
  SELECT DISTINCT "other_release"."subprofile_id" AS "other_id", 2 AS "score"
    FROM "studio_releases" "artist_release"
    INNER JOIN "studio_scenes" "scene"
       ON "scene"."id" = "artist_release"."scene_id"
      AND "scene"."status" = 'active'
    INNER JOIN "studio_releases" "other_release"
       ON "other_release"."scene_id" = "artist_release"."scene_id"
   WHERE "artist_release"."subprofile_id" = $2
     AND "artist_release"."status" = 'published'
     AND "other_release"."subprofile_id" <> $2
     AND "other_release"."status" = 'published'
),
"genre_score" AS (
  SELECT "other_genre"."subprofile_id" AS "other_id", LEAST(COUNT(*), 2) AS "score"
    FROM (
      SELECT DISTINCT "subprofile_id", "genre" FROM "studio_releases"
       WHERE "status" = 'published' AND "genre" IS NOT NULL AND "subprofile_id" <> $2
    ) "other_genre"
    INNER JOIN (
      SELECT DISTINCT "genre" FROM "studio_releases"
       WHERE "status" = 'published' AND "genre" IS NOT NULL AND "subprofile_id" = $2
    ) "artist_genre" ON "artist_genre"."genre" = "other_genre"."genre"
   GROUP BY "other_genre"."subprofile_id"
),
"scored" AS (
  SELECT "candidate".*,
         CAST(
           COALESCE("credit_score"."score", 0)
           + COALESCE("playlist_score"."score", 0)
           + COALESCE("scene_score"."score", 0)
           + COALESCE("genre_score"."score", 0)
         AS int) AS "score"
    FROM "candidate"
    LEFT JOIN "credit_score" ON "credit_score"."other_id" = "candidate"."artist_id"
    LEFT JOIN "playlist_score" ON "playlist_score"."other_id" = "candidate"."artist_id"
    LEFT JOIN "scene_score" ON "scene_score"."other_id" = "candidate"."artist_id"
    LEFT JOIN "genre_score" ON "genre_score"."other_id" = "candidate"."artist_id"
)
SELECT "scored"."artist_id", "scored"."artist_handle", "scored"."artist_display_name",
       "scored"."artist_kind", "scored"."artist_avatar_url", "scored"."score"
  FROM "scored"
 WHERE "scored"."score" > 0
 ORDER BY "scored"."score" DESC, "scored"."newest_published_at" DESC, "scored"."artist_id" ASC
 LIMIT $3`;

/**
 * Studio discovery: related artists, computed per request from public data
 * (no nightly table). The 404 check runs first, so nothing is scored for an
 * artist the viewer cannot see.
 */
@Injectable()
export class StudioRelatedArtistsService {
  constructor(private readonly dataSource: DataSource) {}

  async listRelated(
    viewerId: string,
    subprofileId: string,
  ): Promise<{ items: StudioArtistRef[] }> {
    const found: unknown[] = await this.dataSource.query(
      LISTENABLE_ARTIST_SQL,
      [viewerId, subprofileId],
    );
    if (!found.length) {
      throw new NotFoundException('Artist not found');
    }
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      RELATED_ARTISTS_SQL,
      [viewerId, subprofileId, STUDIO_DISCOVERY_LIMITS.relatedArtistsMax],
    );
    return {
      items: rows.map((row) =>
        artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
      ),
    };
  }
}
