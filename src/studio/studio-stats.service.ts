import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { SavedKind } from '../saved/entities/saved-item.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { isPodcastRelease } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { publiclyListedPlaylistSql } from './studio-playlist-visibility';
import { toReleaseHealth } from './studio-release-health';
import {
  StudioArtistStats,
  StudioFollowerGrowthWeek,
  followerGrowthWeekStarts,
  orderReleasesForStats,
  playWindowDays,
  toFollowerGrowth,
  toNextRelease,
  toStudioCount,
} from './studio-stats';
import {
  statsForTracks,
  toStudioReleaseCard,
  toStudioTrackSummary,
} from './studio-response';

interface SaveCountRow {
  subject_type: SavedKind;
  subject_id: string;
  save_count: number | string;
}

interface TrackInclusionRow {
  track_id: string;
  inclusion_count: number | string;
}

interface ReleaseInclusionRow {
  release_id: string;
  inclusion_count: number | string;
}

interface ReminderCountRow {
  release_id: string;
  reminder_count: number | string;
}

interface FollowerGrowthRow {
  week_start: string;
  new_followers: number | string;
}

interface PlayCountRow {
  track_id: string;
  plays: number | string;
  plays_28d: number | string;
}

interface LatestVersionRow {
  release_id: string;
  latest_created_at: Date | string;
}

/**
 * Studio v2 "Your numbers": current totals for a persona's owners and
 * co-owners. Everything comes from data that already exists; plays come
 * from the anonymous daily totals. Nine grouped queries at most per page,
 * whatever the catalogue size: releases, tracks, saves, track inclusions,
 * release inclusions, daily plays, weekly new followers, Notify me reminders
 * for scheduled releases only, and version dates for published releases
 * whose tracks changed only (plus the follower count).
 */
@Injectable()
export class StudioStatsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    private readonly ownership: StudioOwnershipService,
    private readonly followers: SubprofileFollowersService,
  ) {}

  /** Owners and co-owners only; anyone else, and an unknown persona, 404. */
  async getArtistStats(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioArtistStats> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const persona = await this.subprofiles.findOne({
      where: { id: subprofileId },
      select: {
        id: true,
        handle: true,
        displayName: true,
        kind: true,
        avatarUrl: true,
      },
    });
    if (!persona) {
      throw new NotFoundException('Artist not found');
    }
    // The stored id from here on: a link may carry it in any letter case.
    const followerCounts = await this.followers.loadFollowerCountsFor([
      persona.id,
    ]);
    const followerGrowth = await this.followerGrowth(
      persona.id,
      followerGrowthWeekStarts(new Date()),
    );
    const orderedReleases = orderReleasesForStats(
      await this.releases.find({
        where: { subprofileId },
        relations: { scene: true },
      }),
    );
    const releaseIds = orderedReleases.map((release) => release.id);
    const releaseTracks = releaseIds.length
      ? await this.tracks.find({
          where: { releaseId: In(releaseIds) },
          order: { position: 'ASC' },
        })
      : [];
    const trackIds = releaseTracks.map((track) => track.id);
    const saves = await this.saveCounts(releaseIds, trackIds);
    const trackInclusions = await this.trackInclusionCounts(trackIds);
    const releaseInclusions = await this.releaseInclusionCounts(releaseIds);
    const playCounts = await this.playCounts(
      trackIds,
      playWindowDays(new Date())[0] ?? '',
    );
    const reminderCounts = await this.reminderCounts(
      orderedReleases
        .filter((release) => release.status === StudioReleaseStatus.Scheduled)
        .map((release) => release.id),
    );
    const latestVersionDates = await this.latestVersionDates(
      orderedReleases
        .filter(
          (release) =>
            release.status === StudioReleaseStatus.Published &&
            Boolean(release.tracksChangedAt),
        )
        .map((release) => release.id),
    );
    return {
      subprofileId: persona.id,
      followerCount: followerCounts.get(persona.id) ?? 0,
      followerGrowth,
      nextRelease: toNextRelease(orderedReleases, reminderCounts),
      releases: orderedReleases.map((release) => {
        const tracksOfRelease = releaseTracks.filter(
          (track) => track.releaseId === release.id,
        );
        // Studio artist kinds: a show has no per-episode numbers, and an
        // episode never counts a play.
        const rowTracks = isPodcastRelease(release) ? [] : tracksOfRelease;
        const playsOf = (track: StudioTrack) =>
          playCounts.get(track.id) ?? { plays: 0, plays28d: 0 };
        return {
          release: {
            ...toStudioReleaseCard(
              release,
              persona,
              statsForTracks(tracksOfRelease),
            ),
            status: release.status,
          },
          saves: toStudioCount(saves.byReleaseId.get(release.id) ?? 0),
          playlistInclusions: toStudioCount(
            releaseInclusions.get(release.id) ?? 0,
          ),
          reminders:
            release.status === StudioReleaseStatus.Scheduled
              ? toStudioCount(reminderCounts.get(release.id) ?? 0)
              : null,
          // Withheld tracks are summed in; each sum is floored once.
          plays: toStudioCount(
            rowTracks.reduce((sum, track) => sum + playsOf(track).plays, 0),
          ),
          plays28d: toStudioCount(
            rowTracks.reduce((sum, track) => sum + playsOf(track).plays28d, 0),
          ),
          tracks: rowTracks.map((track) => ({
            track: toStudioTrackSummary(track),
            saves: toStudioCount(saves.byTrackId.get(track.id) ?? 0),
            playlistInclusions: toStudioCount(
              trackInclusions.get(track.id) ?? 0,
            ),
            plays: toStudioCount(playsOf(track).plays),
            plays28d: toStudioCount(playsOf(track).plays28d),
          })),
          health: toReleaseHealth(
            release,
            tracksOfRelease,
            latestVersionDates.get(release.id) ?? null,
          ),
        };
      }),
    };
  }

  /** Studio dashboard: new followers per UTC week from the first week
   *  start on, one grouped read. Counts only. */
  private async followerGrowth(
    subprofileId: string,
    weekStarts: string[],
  ): Promise<StudioFollowerGrowthWeek[]> {
    const rows: FollowerGrowthRow[] = await this.dataSource.query(
      `SELECT to_char(date_trunc('week', "follower"."created_at" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "week_start",
              COUNT(*)::int AS "new_followers"
         FROM "subprofile_followers" "follower"
        WHERE "follower"."subprofile_id" = $1
          AND "follower"."created_at" >= $2::timestamptz
        GROUP BY 1`,
      [subprofileId, `${weekStarts[0]}T00:00:00.000Z`],
    );
    return toFollowerGrowth(weekStarts, rows);
  }

  /** Studio dashboard: the newest version note date per release, read for
   *  published releases whose tracks changed. */
  private async latestVersionDates(
    releaseIds: string[],
  ): Promise<Map<string, Date>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows: LatestVersionRow[] = await this.dataSource.query(
      `SELECT "version"."release_id" AS "release_id",
              MAX("version"."created_at") AS "latest_created_at"
         FROM "studio_release_versions" "version"
        WHERE "version"."release_id" = ANY($1::uuid[])
        GROUP BY "version"."release_id"`,
      [releaseIds],
    );
    return new Map(
      rows.map((row) => [row.release_id, new Date(row.latest_created_at)]),
    );
  }

  private async saveCounts(
    releaseIds: string[],
    trackIds: string[],
  ): Promise<{
    byReleaseId: Map<string, number>;
    byTrackId: Map<string, number>;
  }> {
    const byReleaseId = new Map<string, number>();
    const byTrackId = new Map<string, number>();
    if (!releaseIds.length && !trackIds.length) {
      return { byReleaseId, byTrackId };
    }
    const rows: SaveCountRow[] = await this.dataSource.query(
      `SELECT "saved"."subject_type"::text AS "subject_type",
              "saved"."subject_id" AS "subject_id",
              COUNT(*)::int AS "save_count"
         FROM "saved_item" "saved"
        WHERE ("saved"."subject_type" = '${SavedKind.StudioRelease}' AND "saved"."subject_id" = ANY($1::text[]))
           OR ("saved"."subject_type" = '${SavedKind.StudioTrack}' AND "saved"."subject_id" = ANY($2::text[]))
        GROUP BY "saved"."subject_type", "saved"."subject_id"`,
      [releaseIds, trackIds],
    );
    for (const row of rows) {
      const target =
        row.subject_type === SavedKind.StudioRelease ? byReleaseId : byTrackId;
      target.set(row.subject_id, Number(row.save_count));
    }
    return { byReleaseId, byTrackId };
  }

  private async trackInclusionCounts(
    trackIds: string[],
  ): Promise<Map<string, number>> {
    if (!trackIds.length) {
      return new Map();
    }
    const rows: TrackInclusionRow[] = await this.dataSource.query(
      `SELECT "entry"."track_id" AS "track_id",
              COUNT(DISTINCT "entry"."playlist_id")::int AS "inclusion_count"
         FROM "studio_playlist_tracks" "entry"
        INNER JOIN "studio_playlists" "playlist" ON "playlist"."id" = "entry"."playlist_id"
        WHERE "entry"."track_id" = ANY($1::uuid[])
          AND ${publiclyListedPlaylistSql('playlist')}
        GROUP BY "entry"."track_id"`,
      [trackIds],
    );
    return new Map(
      rows.map((row) => [row.track_id, Number(row.inclusion_count)]),
    );
  }

  private async releaseInclusionCounts(
    releaseIds: string[],
  ): Promise<Map<string, number>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows: ReleaseInclusionRow[] = await this.dataSource.query(
      `SELECT "track"."release_id" AS "release_id",
              COUNT(DISTINCT "entry"."playlist_id")::int AS "inclusion_count"
         FROM "studio_playlist_tracks" "entry"
        INNER JOIN "studio_tracks" "track" ON "track"."id" = "entry"."track_id"
        INNER JOIN "studio_playlists" "playlist" ON "playlist"."id" = "entry"."playlist_id"
        WHERE "track"."release_id" = ANY($1::uuid[])
          AND ${publiclyListedPlaylistSql('playlist')}
        GROUP BY "track"."release_id"`,
      [releaseIds],
    );
    return new Map(
      rows.map((row) => [row.release_id, Number(row.inclusion_count)]),
    );
  }

  /** Studio v3: Notify me reminders per scheduled release, one grouped
   *  read. It answers counts only. */
  private async reminderCounts(
    releaseIds: string[],
  ): Promise<Map<string, number>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows: ReminderCountRow[] = await this.dataSource.query(
      `SELECT "reminder"."release_id" AS "release_id",
              COUNT(*)::int AS "reminder_count"
         FROM "studio_release_reminders" "reminder"
        WHERE "reminder"."release_id" = ANY($1::uuid[])
        GROUP BY "reminder"."release_id"`,
      [releaseIds],
    );
    return new Map(
      rows.map((row) => [row.release_id, Number(row.reminder_count)]),
    );
  }

  /** Studio dashboard listening: all-time and window plays per track from
   *  the anonymous daily totals, one grouped read. Counts only. */
  private async playCounts(
    trackIds: string[],
    windowStartDay: string,
  ): Promise<Map<string, { plays: number; plays28d: number }>> {
    if (!trackIds.length) {
      return new Map();
    }
    const rows: PlayCountRow[] = await this.dataSource.query(
      `SELECT "daily"."track_id" AS "track_id",
              SUM("daily"."plays")::bigint AS "plays",
              COALESCE(SUM("daily"."plays") FILTER (WHERE "daily"."day" >= $2::date), 0)::bigint AS "plays_28d"
         FROM "studio_track_play_daily" "daily"
        WHERE "daily"."track_id" = ANY($1::uuid[])
        GROUP BY "daily"."track_id"`,
      [trackIds, windowStartDay],
    );
    return new Map(
      rows.map((row) => [
        row.track_id,
        { plays: Number(row.plays), plays28d: Number(row.plays_28d) },
      ]),
    );
  }
}
