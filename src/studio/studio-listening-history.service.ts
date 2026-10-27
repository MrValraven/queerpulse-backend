import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  artistRefFromColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import {
  STUDIO_LISTENING_RANGE_INTERVALS,
  STUDIO_LISTENING_TOP_SHOWN,
  STUDIO_LISTENS_PER_PAGE,
  StudioListen,
  StudioListeningRange,
  StudioListeningSummary,
  StudioListeningTopArtist,
  StudioListeningTopTrack,
  StudioListensPage,
  decodeListenCursor,
  encodeListenCursor,
} from './studio-listening-history';
import { blockedWithAnyPersonaMemberSql } from './studio-persona-members';
import { studioTrackArtistIdsSql } from './studio-play-attribution';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistEntryTrack } from './studio-playlist-response';
import { playableTrackSql } from './studio-playlist-visibility';
import { StudioReleaseCard, toStudioTrackSummary } from './studio-response';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';
import { listenablePersonaSql } from './studio-visibility';

/**
 * `$1` the caller, `$2` the window as interval text. Every listen of the
 * caller in the window, and the distinct UTC days that hold one.
 */
export const LISTENING_TOTALS_SQL = `SELECT COUNT(*)::int AS "total_listens",
       COUNT(DISTINCT ("listen"."played_at" AT TIME ZONE 'UTC')::date)::int AS "listening_days"
  FROM "studio_listens" "listen"
 WHERE "listen"."user_id" = $1
   AND "listen"."played_at" >= now() - $2::interval`;

/**
 * `$1` the caller, `$2` the window, `$3` the Studio artist kinds, `$4` how
 * many rows. Each listen counts once for every persona the track is
 * attributed to right now (the release persona plus accepted credits). A
 * persona outside the artist kinds, one that is not listenable and one with
 * a block either way between the caller and any of its members are left
 * out.
 */
export const TOP_ARTISTS_SQL = `SELECT ${personaColumnsSql('artist', 'artist')},
       COUNT(*)::int AS "listen_count",
       MAX("listen"."played_at") AS "latest_played_at"
  FROM "studio_listens" "listen"
 INNER JOIN "studio_tracks" "track" ON "track"."id" = "listen"."track_id"
 CROSS JOIN LATERAL ${studioTrackArtistIdsSql('track')} "attributed"
 INNER JOIN "subprofiles" "artist" ON "artist"."id" = "attributed"."artist_id"
 WHERE "listen"."user_id" = $1
   AND "listen"."played_at" >= now() - $2::interval
   AND "artist"."kind"::text = ANY($3::text[])
   AND ${listenablePersonaSql('artist')}
   AND NOT ${blockedWithAnyPersonaMemberSql('$1', '"artist"."id"')}
 GROUP BY "artist"."id"
 ORDER BY "listen_count" DESC, "latest_played_at" DESC, "artist"."id" ASC
 LIMIT $4`;

/**
 * `$1` the caller, `$2` the window, `$3` how many rows. The caller's most
 * played tracks in the window among those they can play right now: a
 * playable track and no block either way with the release persona creator.
 */
export const TOP_TRACKS_SQL = `SELECT "listen"."track_id" AS "track_id",
       COUNT(*)::int AS "listen_count",
       MAX("listen"."played_at") AS "latest_played_at"
  FROM "studio_listens" "listen"
 INNER JOIN "studio_tracks" "track" ON "track"."id" = "listen"."track_id"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "listen"."user_id" = $1
   AND "listen"."played_at" >= now() - $2::interval
   AND ${playableTrackSql('track', 'release', 'persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'top_track_block')}
 GROUP BY "listen"."track_id"
 ORDER BY "listen_count" DESC, "latest_played_at" DESC, "listen"."track_id" ASC
 LIMIT $3`;

/**
 * `$1` the caller, `$2`/`$3` the cursor time and listen id or nulls, `$4`
 * the page size plus one. The caller's listens, newest first, with the id
 * as the tiebreak. `played_at` holds milliseconds, the precision a cursor
 * carries, so the keyset compares the stored value.
 */
export const RECENT_LISTENS_SQL = `SELECT "listen"."id" AS "id",
       "listen"."track_id" AS "track_id",
       "listen"."played_at" AS "played_at"
  FROM "studio_listens" "listen"
 WHERE "listen"."user_id" = $1
   AND ($2::timestamptz IS NULL OR ("listen"."played_at", "listen"."id") < ($2::timestamptz, $3::uuid))
 ORDER BY "listen"."played_at" DESC, "listen"."id" DESC
 LIMIT $4`;

/** `$1` the caller. Every listen of the caller, and only theirs. */
export const CLEAR_LISTENS_SQL = `DELETE FROM "studio_listens" WHERE "user_id" = $1`;

interface ListeningTotalsRow {
  total_listens: number | string;
  listening_days: number | string;
}

interface TopArtistRow extends Record<string, unknown> {
  listen_count: number | string;
}

interface TopTrackRow {
  track_id: string;
  listen_count: number | string;
}

interface RecentListenRow {
  id: string;
  track_id: string;
  played_at: Date | string;
}

/**
 * A member's own listening history: the summary over a window, the recent
 * list and the clear. Every read takes the caller's own rows only, the
 * counts are the caller's own and stay unfloored, and nothing here is read
 * for anyone else. Tracks resolve through the playlist entry rule
 * (`StudioPlaylistReadsService.playableTracks`) and then the release card,
 * the shape Liked songs serves.
 */
@Injectable()
export class StudioListeningHistoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly playlistReads: StudioPlaylistReadsService,
    private readonly catalog: StudioCatalogService,
  ) {}

  async getSummary(
    userId: string,
    range: StudioListeningRange,
  ): Promise<StudioListeningSummary> {
    const interval = STUDIO_LISTENING_RANGE_INTERVALS[range];
    const [totalsRows, artistRows, trackRows] = await Promise.all([
      this.dataSource.query<ListeningTotalsRow[]>(LISTENING_TOTALS_SQL, [
        userId,
        interval,
      ]),
      this.dataSource.query<TopArtistRow[]>(TOP_ARTISTS_SQL, [
        userId,
        interval,
        [...STUDIO_ARTIST_PERSONA_KINDS],
        STUDIO_LISTENING_TOP_SHOWN,
      ]),
      this.dataSource.query<TopTrackRow[]>(TOP_TRACKS_SQL, [
        userId,
        interval,
        STUDIO_LISTENING_TOP_SHOWN,
      ]),
    ]);
    const totals = totalsRows[0];
    const topArtists: StudioListeningTopArtist[] = artistRows.map(
      (artistRow) => ({
        artist: artistRefFromColumns(
          personaColumnsFromRow(artistRow, 'artist'),
        ),
        listens: Number(artistRow.listen_count),
      }),
    );
    const entryTracks = await this.entryTracksFor(
      userId,
      trackRows.map((trackRow) => trackRow.track_id),
    );
    // A track the playlist entry rule drops since the window read is left
    // out of the list.
    const topTracks: StudioListeningTopTrack[] = trackRows.flatMap(
      (trackRow) => {
        const entryTrack = entryTracks.get(trackRow.track_id);
        return entryTrack
          ? [{ track: entryTrack, listens: Number(trackRow.listen_count) }]
          : [];
      },
    );
    return {
      range,
      totalListens: Number(totals?.total_listens ?? 0),
      listeningDays: Number(totals?.listening_days ?? 0),
      topArtists,
      topTracks,
    };
  }

  async listRecent(
    userId: string,
    cursor: string | undefined,
  ): Promise<StudioListensPage> {
    const decodedCursor = decodeListenCursor(cursor);
    const rows = await this.dataSource.query<RecentListenRow[]>(
      RECENT_LISTENS_SQL,
      [
        userId,
        decodedCursor?.playedAt ?? null,
        decodedCursor?.id ?? null,
        STUDIO_LISTENS_PER_PAGE + 1,
      ],
    );
    const hasMore = rows.length > STUDIO_LISTENS_PER_PAGE;
    const pageRows = hasMore ? rows.slice(0, STUDIO_LISTENS_PER_PAGE) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const entryTracks = await this.entryTracksFor(userId, [
      ...new Set(pageRows.map((row) => row.track_id)),
    ]);
    const items: StudioListen[] = pageRows.map((row) => ({
      id: row.id,
      playedAt: new Date(row.played_at).toISOString(),
      track: entryTracks.get(row.track_id) ?? null,
    }));
    return {
      items,
      nextCursor:
        hasMore && lastRow
          ? encodeListenCursor({
              playedAt: new Date(lastRow.played_at),
              id: lastRow.id,
            })
          : null,
    };
  }

  /** Deletes every listen of the caller. Daily play totals, supporter
   *  opt-ins and the history switch stay as they are. */
  async clearHistory(userId: string): Promise<void> {
    await this.dataSource.query(CLEAR_LISTENS_SQL, [userId]);
  }

  // The tracks among `trackIds` the caller can play now, each with its
  // release card, keyed by track id. A track whose card is missing is left
  // out, as a playlist entry would be.
  private async entryTracksFor(
    userId: string,
    trackIds: string[],
  ): Promise<Map<string, StudioPlaylistEntryTrack>> {
    const playable = trackIds.length
      ? await this.playlistReads.playableTracks(userId, trackIds)
      : new Map<string, StudioTrack>();
    const releaseIds = [
      ...new Set([...playable.values()].map((track) => track.releaseId)),
    ];
    const releaseCards = releaseIds.length
      ? await this.catalog.cardsByReleaseId(releaseIds)
      : new Map<string, StudioReleaseCard>();
    const entryTracks = new Map<string, StudioPlaylistEntryTrack>();
    for (const [trackId, track] of playable) {
      const release = releaseCards.get(track.releaseId);
      if (release) {
        entryTracks.set(trackId, { ...toStudioTrackSummary(track), release });
      }
    }
    return entryTracks;
  }
}
