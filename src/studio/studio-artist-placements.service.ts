import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioOwnershipService } from './studio-ownership.service';
import { blockedWithAnyPersonaMemberSql } from './studio-persona-members';
import {
  STUDIO_PLACEMENTS_PER_PAGE,
  STUDIO_PLACEMENT_TRACKS_SHOWN,
  StudioPlacement,
  StudioPlacementTrack,
  StudioPlacementsPage,
  decodePlacementCursor,
  encodePlacementCursor,
} from './studio-placements';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  creditPersonaCreatorIdSql,
  publiclyListedPlaylistSql,
} from './studio-playlist-visibility';

/**
 * `$1` the persona, `$2`/`$3` the cursor time and playlist id or nulls, `$4`
 * the page size plus one. Every publicly listed playlist holding a track of
 * the persona, by its latest addition of such a track, newest first. The
 * time is truncated to milliseconds on the select and the comparison alike,
 * the precision a cursor carries. Each playlist counts the persona's
 * distinct tracks.
 */
export const PLACEMENT_PAGE_SQL = `SELECT "playlist"."id" AS "playlist_id",
       date_trunc('milliseconds', MAX("entry"."added_at")) AS "latest_added_at",
       COUNT(DISTINCT "track"."id")::int AS "track_count"
  FROM "studio_playlist_tracks" "entry"
 INNER JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "studio_playlists" "playlist" ON "playlist"."id" = "entry"."playlist_id"
 WHERE "release"."subprofile_id" = $1
   AND ${publiclyListedPlaylistSql('playlist')}
   AND NOT ${blockedWithAnyPersonaMemberSql('"playlist"."user_id"', '$1')}
   AND NOT ${blockedWithAnyPersonaMemberSql(creditPersonaCreatorIdSql('playlist'), '$1')}
 GROUP BY "playlist"."id"
HAVING $2::timestamptz IS NULL
    OR (date_trunc('milliseconds', MAX("entry"."added_at")), "playlist"."id") < ($2::timestamptz, $3::uuid)
 ORDER BY "latest_added_at" DESC, "playlist"."id" DESC
 LIMIT $4`;

/**
 * `$1` the persona, `$2` the playlist ids of a page, `$3` how many tracks
 * each playlist shows. The persona's tracks in each playlist, each track
 * once at its first position, in position order.
 */
export const PLACEMENT_TRACKS_SQL = `SELECT "ranked"."playlist_id", "ranked"."track_id", "ranked"."title", "ranked"."release_id"
  FROM (
    SELECT "first_entry".*,
           row_number() OVER (PARTITION BY "first_entry"."playlist_id" ORDER BY "first_entry"."position" ASC) AS "track_rank"
      FROM (
        SELECT DISTINCT ON ("entry"."playlist_id", "track"."id")
               "entry"."playlist_id" AS "playlist_id", "track"."id" AS "track_id",
               "track"."title" AS "title", "track"."release_id" AS "release_id",
               "entry"."position" AS "position"
          FROM "studio_playlist_tracks" "entry"
         INNER JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
         INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
         WHERE "entry"."playlist_id" = ANY($2::uuid[])
           AND "release"."subprofile_id" = $1
         ORDER BY "entry"."playlist_id", "track"."id", "entry"."position" ASC
      ) "first_entry"
  ) "ranked"
 WHERE "ranked"."track_rank" <= $3
 ORDER BY "ranked"."playlist_id", "ranked"."position" ASC`;

interface PlacementPageRow {
  playlist_id: string;
  latest_added_at: Date;
  track_count: number | string;
}

interface PlacementTrackRow {
  playlist_id: string;
  track_id: string;
  title: string;
  release_id: string;
}

/**
 * Studio dashboard "Where your music lives": the public playlists holding
 * the persona's tracks, for its creator and co-owners. A playlist the
 * creator or a co-owner owns is listed here too (the milestone sweep alone
 * leaves such self-placements out). A block either way between any persona
 * member and the playlist owner, or the creator of the persona the playlist
 * is credited to, leaves the playlist out. Nothing here records who opened
 * the list.
 */
@Injectable()
export class StudioArtistPlacementsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly playlistReads: StudioPlaylistReadsService,
  ) {}

  /** Owners and co-owners only; anyone else, and an unknown persona, 404. */
  async listPlacements(
    viewerId: string,
    subprofileId: string,
    cursor: string | undefined,
  ): Promise<StudioPlacementsPage> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const decodedCursor = decodePlacementCursor(cursor);
    const rows: PlacementPageRow[] = await this.dataSource.query(
      PLACEMENT_PAGE_SQL,
      [
        subprofileId,
        decodedCursor?.latestAddedAt ?? null,
        decodedCursor?.playlistId ?? null,
        STUDIO_PLACEMENTS_PER_PAGE + 1,
      ],
    );
    const hasMore = rows.length > STUDIO_PLACEMENTS_PER_PAGE;
    const pageRows = hasMore ? rows.slice(0, STUDIO_PLACEMENTS_PER_PAGE) : rows;
    if (!pageRows.length) {
      return { items: [], nextCursor: null };
    }
    const playlistIds = pageRows.map((row) => row.playlist_id);
    const trackRows: PlacementTrackRow[] = await this.dataSource.query(
      PLACEMENT_TRACKS_SQL,
      [subprofileId, playlistIds, STUDIO_PLACEMENT_TRACKS_SHOWN],
    );
    const cardsByPlaylistId = await this.playlistReads.cardsForPlaylistIds(
      viewerId,
      playlistIds,
    );
    const tracksByPlaylistId = new Map<string, StudioPlacementTrack[]>();
    for (const trackRow of trackRows) {
      const playlistTracks = tracksByPlaylistId.get(trackRow.playlist_id) ?? [];
      playlistTracks.push({
        id: trackRow.track_id,
        title: trackRow.title,
        releaseId: trackRow.release_id,
      });
      tracksByPlaylistId.set(trackRow.playlist_id, playlistTracks);
    }
    const items = pageRows.flatMap((row): StudioPlacement[] => {
      const playlistCard = cardsByPlaylistId.get(row.playlist_id);
      if (!playlistCard) {
        return [];
      }
      return [
        {
          playlist: playlistCard,
          tracks: tracksByPlaylistId.get(row.playlist_id) ?? [],
          trackCount: Number(row.track_count),
          latestAddedAt: new Date(row.latest_added_at).toISOString(),
        },
      ];
    });
    const lastRow = pageRows[pageRows.length - 1]!;
    return {
      items,
      nextCursor: hasMore
        ? encodePlacementCursor({
            latestAddedAt: new Date(lastRow.latest_added_at),
            playlistId: lastRow.playlist_id,
          })
        : null,
    };
  }
}
