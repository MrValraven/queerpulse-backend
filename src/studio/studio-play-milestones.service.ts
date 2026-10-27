import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  studioPersonaTrackIdsSql,
  studioTrackArtistIdsSql,
} from './studio-play-attribution';
import { describePlayErrorWithoutIds } from './studio-play-log';
import {
  artistPlayMilestoneThresholdsUpTo,
  trackPlayMilestoneThresholdsUpTo,
} from './studio-milestones';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

/**
 * Every artist persona the track is attributed to, with the track's all-time
 * daily sum and the persona's all-time daily sum over every track attributed
 * to it (credited tracks included). `$1` track, `$2` artist kinds.
 */
export const PLAY_MILESTONE_TOTALS_SQL = `SELECT "artist"."id" AS "artist_id",
       (SELECT COALESCE(SUM("track_daily"."plays"), 0) FROM "studio_track_play_daily" "track_daily"
         WHERE "track_daily"."track_id" = "track"."id")::bigint AS "track_total",
       (SELECT COALESCE(SUM("artist_daily"."plays"), 0) FROM "studio_track_play_daily" "artist_daily"
         WHERE "artist_daily"."track_id" IN ${studioPersonaTrackIdsSql('"artist"."id"')})::bigint AS "artist_total"
  FROM "studio_tracks" "track"
 CROSS JOIN LATERAL ${studioTrackArtistIdsSql('track')} "attributed"
 INNER JOIN "subprofiles" "artist" ON "artist"."id" = "attributed"."artist_id"
 WHERE "track"."id" = $1
   AND "artist"."kind"::text = ANY($2::text[])
 ORDER BY "artist"."id" ASC`;

/** One `track_plays` row per artist and threshold; a reached threshold stays as it was. */
export const TRACK_PLAY_MILESTONES_INSERT_SQL = `INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold", "track_id")
SELECT "artist_id", 'track_plays', "threshold", $3::uuid
  FROM unnest($1::uuid[]) AS "artist_id"
 CROSS JOIN unnest($2::int[]) AS "threshold"
ON CONFLICT DO NOTHING`;

/** One `artist_plays` row per artist and threshold, paired by position. */
export const ARTIST_PLAY_MILESTONES_INSERT_SQL = `INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold")
SELECT "reached"."artist_id", 'artist_plays', "reached"."threshold"
  FROM unnest($1::uuid[], $2::int[]) AS "reached"("artist_id", "threshold")
ON CONFLICT DO NOTHING`;

interface PlayMilestoneTotalRow {
  artist_id: string;
  track_total: number | string;
  artist_total: number | string;
}

/**
 * Studio dashboard: play milestones (contract section 9). Runs after a
 * counted play commits, for every artist persona the track is attributed to.
 * Every threshold at or below the current total is written with `ON CONFLICT
 * DO NOTHING`, so a missed write heals on the next counted play, and a credit
 * accepted later writes its crossed thresholds on the next play of any
 * credited track. Nothing is removed when a total drops. Best effort: a
 * failure is logged with no track or persona id and is never thrown.
 */
@Injectable()
export class StudioPlayMilestonesService {
  private readonly logger = new Logger(StudioPlayMilestonesService.name);

  constructor(private readonly dataSource: DataSource) {}

  async recordPlayMilestones(trackId: string): Promise<void> {
    try {
      const rows: PlayMilestoneTotalRow[] = await this.dataSource.query(
        PLAY_MILESTONE_TOTALS_SQL,
        [trackId, [...STUDIO_ARTIST_PERSONA_KINDS]],
      );
      if (rows.length === 0) return;

      const artistIds = rows.map((row) => row.artist_id);
      const trackThresholds = trackPlayMilestoneThresholdsUpTo(
        Number(rows[0]?.track_total ?? 0),
      );
      if (trackThresholds.length > 0) {
        await this.dataSource.query(TRACK_PLAY_MILESTONES_INSERT_SQL, [
          artistIds,
          trackThresholds,
          trackId,
        ]);
      }

      const reachedArtistIds: string[] = [];
      const reachedArtistThresholds: number[] = [];
      for (const row of rows) {
        for (const threshold of artistPlayMilestoneThresholdsUpTo(
          Number(row.artist_total),
        )) {
          reachedArtistIds.push(row.artist_id);
          reachedArtistThresholds.push(threshold);
        }
      }
      if (reachedArtistIds.length > 0) {
        await this.dataSource.query(ARTIST_PLAY_MILESTONES_INSERT_SQL, [
          reachedArtistIds,
          reachedArtistThresholds,
        ]);
      }
    } catch (error) {
      this.logger.warn(
        `Recording play milestones failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }
}
