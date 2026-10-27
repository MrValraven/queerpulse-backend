import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioOwnershipService } from './studio-ownership.service';
import { studioPersonaTrackIdsSql } from './studio-play-attribution';
import {
  StudioArtistPlays,
  playWindowDays,
  toArtistPlays,
} from './studio-stats';

/** Plays per UTC day from `$2` (the first window day) on, over the tracks
 *  attributed to persona `$1`. */
export const ARTIST_PLAY_DAYS_SQL = `SELECT to_char("daily"."day", 'YYYY-MM-DD') AS "day",
       SUM("daily"."plays")::bigint AS "plays"
  FROM "studio_track_play_daily" "daily"
 WHERE "daily"."track_id" IN ${studioPersonaTrackIdsSql('$1')}
   AND "daily"."day" >= $2::date
 GROUP BY "daily"."day"
 ORDER BY "daily"."day" ASC`;

/** All-time plays over the tracks attributed to persona `$1`. */
export const ARTIST_PLAY_TOTAL_SQL = `SELECT COALESCE(SUM("daily"."plays"), 0)::bigint AS "total"
  FROM "studio_track_play_daily" "daily"
 WHERE "daily"."track_id" IN ${studioPersonaTrackIdsSql('$1')}`;

interface ArtistPlayDayRow {
  day: string;
  plays: number | string;
}

interface ArtistPlayTotalRow {
  total: number | string;
}

/**
 * Studio dashboard listening (contract section 7): the 28-day play trend and
 * totals for a persona's owners and co-owners. It reads the anonymous daily
 * totals over the persona's own and credited tracks
 * (`studioPersonaTrackIdsSql`), and every artist-facing value is floored
 * with `toStudioCount`.
 */
@Injectable()
export class StudioArtistPlaysService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
  ) {}

  /** Owners and co-owners only; anyone else, and an unknown persona, 404
   *  before any other read. */
  async getArtistPlays(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioArtistPlays> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const windowDays = playWindowDays(new Date());
    const dayRows: ArtistPlayDayRow[] = await this.dataSource.query(
      ARTIST_PLAY_DAYS_SQL,
      [subprofileId, windowDays[0]],
    );
    const totalRows: ArtistPlayTotalRow[] = await this.dataSource.query(
      ARTIST_PLAY_TOTAL_SQL,
      [subprofileId],
    );
    return toArtistPlays(windowDays, dayRows, Number(totalRows[0]?.total ?? 0));
  }
}
