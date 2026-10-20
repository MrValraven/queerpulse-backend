import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { StudioRadioQuery } from './dto/studio-radio.query';
import {
  artistRefFromColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { StudioReleaseType } from './entities/studio-release.entity';
import { playableTrackSql } from './studio-playlist-visibility';
import { StudioArtistRef } from './studio-response';
import {
  StudioContentWarningId,
  effectiveContentWarnings,
} from './studio-safety.constants';
import { STUDIO_DISCOVERY_LIMITS, studioError } from './studio.constants';

/** Everything the player needs for one queue item without a release fetch. */
export interface StudioRadioItem {
  trackId: string;
  title: string;
  /** Always set: only tracks with confirmed audio are returned. */
  durationSeconds: number;
  isExplicit: boolean;
  releaseId: string;
  releaseTitle: string;
  coverUrl: string | null;
  artist: StudioArtistRef;
  /** Studio safety: the artist's and our team's warnings, for the player's
   *  ask-first gate on a radio extension. */
  contentWarnings: StudioContentWarningId[];
}

/** Up to 300 items in random server order. The browser shuffles and refills. */
export interface StudioRadio {
  items: StudioRadioItem[];
}

interface RadioRow extends Record<string, unknown> {
  track_id: string;
  title: string;
  duration_seconds: number;
  is_explicit: boolean;
  release_id: string;
  release_title: string;
  cover_key: string | null;
  content_warnings: string[] | null;
  staff_content_warnings: string[] | null;
}

/**
 * `$1` the viewer, `$2` the genre or mood, `$3` the cap. Playable tracks
 * (published release, audio and duration in place, persona listenable, and
 * not withheld (Studio safety, through `playableTrackSql`)) of
 * releases in that genre or mood, creators clear of blocks either way,
 * sampled at random. `filterColumn` is one of two literals.
 * Studio artist kinds: podcast shows stay out, so a radio never plays an episode.
 */
export function radioSql(filterColumn: 'genre' | 'mood'): string {
  return `SELECT "track"."id" AS "track_id",
       "track"."title" AS "title",
       "track"."duration_seconds" AS "duration_seconds",
       "track"."is_explicit" AS "is_explicit",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."cover_key" AS "cover_key",
       "track"."content_warnings" AS "content_warnings",
       "track"."staff_content_warnings" AS "staff_content_warnings",
       ${personaColumnsSql('persona', 'artist')}
  FROM "studio_tracks" "track"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."${filterColumn}" = $2
   AND "release"."type" <> '${StudioReleaseType.Podcast}'
   AND ${playableTrackSql('track', 'release', 'persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'radio_block')}
 ORDER BY random()
 LIMIT $3`;
}

/**
 * Studio discovery: genre and mood radio. One read, nothing written: the
 * queue, its shuffles and its refills live in the browser, and the request
 * itself stays out of the request log, the HTTP metrics and Sentry
 * (`isStudioListeningRequest`).
 */
@Injectable()
export class StudioRadioService {
  constructor(private readonly dataSource: DataSource) {}

  async getRadio(
    viewerId: string,
    query: StudioRadioQuery,
  ): Promise<StudioRadio> {
    const hasGenre = query.genre !== undefined;
    const hasMood = query.mood !== undefined;
    if (hasGenre === hasMood) {
      throw studioError('studio_radio_filter_required');
    }
    const filterColumn = hasGenre ? 'genre' : 'mood';
    const rows: RadioRow[] = await this.dataSource.query(
      radioSql(filterColumn),
      [
        viewerId,
        hasGenre ? query.genre : query.mood,
        STUDIO_DISCOVERY_LIMITS.radioMaxItems,
      ],
    );
    return {
      items: rows.map((row) => ({
        trackId: row.track_id,
        title: row.title,
        durationSeconds: row.duration_seconds,
        isExplicit: row.is_explicit,
        releaseId: row.release_id,
        releaseTitle: row.release_title,
        coverUrl: toImageUrl(row.cover_key),
        artist: artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
        contentWarnings: effectiveContentWarnings(
          row.content_warnings,
          row.staff_content_warnings,
        ),
      })),
    };
  }
}
