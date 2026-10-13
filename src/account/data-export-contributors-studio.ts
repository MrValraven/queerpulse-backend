import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface PlaylistExportRow {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  credit_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PlaylistEntryExportRow {
  playlist_id: string;
  track_title: string | null;
  artist_name: string | null;
  added_at: Date;
}

/**
 * `saved` -> `studioPlaylists` (Studio v2): the playlists the member made,
 * each with its visibility, the persona it shows as (by that persona's name,
 * or null when it shows as the member), and its tracks by title and artist
 * name in playlist order. A track that is gone, or that a persona unlink
 * moved out of reach, keeps its date with a null title and artist.
 *
 * Raw SQL through the `DataSource`, so `AccountModule` needs no
 * `forFeature` registration for two tables it only reads. Nothing about
 * listening exists to export: Studio never records a play.
 */
@Injectable()
export class StudioPlaylistsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'studioPlaylists';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const playlists: PlaylistExportRow[] = await this.dataSource.query(
      `SELECT "playlist"."id" AS "id",
              "playlist"."name" AS "name",
              "playlist"."description" AS "description",
              "playlist"."visibility"::text AS "visibility",
              "credit_persona"."display_name" AS "credit_name",
              "playlist"."created_at" AS "created_at",
              "playlist"."updated_at" AS "updated_at"
         FROM "studio_playlists" "playlist"
         LEFT JOIN "subprofiles" "credit_persona"
           ON "credit_persona"."id" = "playlist"."credit_subprofile_id"
        WHERE "playlist"."user_id" = $1
        ORDER BY "playlist"."created_at" ASC, "playlist"."id" ASC`,
      [userId],
    );
    if (!playlists.length) {
      return [];
    }
    const entries: PlaylistEntryExportRow[] = await this.dataSource.query(
      `SELECT "entry"."playlist_id" AS "playlist_id",
              "track"."title" AS "track_title",
              "persona"."display_name" AS "artist_name",
              "entry"."added_at" AS "added_at"
         FROM "studio_playlist_tracks" "entry"
         LEFT JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
         LEFT JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
        WHERE "entry"."playlist_id" = ANY($1::uuid[])
        ORDER BY "entry"."playlist_id", "entry"."position" ASC, "entry"."id" ASC`,
      [playlists.map((playlist) => playlist.id)],
    );
    return playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      visibility: playlist.visibility,
      creditName: playlist.credit_name,
      tracks: entries
        .filter((entry) => entry.playlist_id === playlist.id)
        .map((entry) => ({
          title: entry.track_title,
          artist: entry.artist_name,
          addedAt: entry.added_at.toISOString(),
        })),
      createdAt: playlist.created_at.toISOString(),
      updatedAt: playlist.updated_at.toISOString(),
    }));
  }
}
