import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { SavedKind } from '../saved/entities/saved-item.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioOwnershipService } from './studio-ownership.service';
import { publiclyListedPlaylistSql } from './studio-playlist-visibility';
import {
  StudioArtistStats,
  orderReleasesForStats,
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

/**
 * Studio v2 "Your numbers": current totals for a persona's owners and
 * co-owners. Everything comes from data that already exists; nothing here
 * reads or records a play. Five grouped queries per page, whatever the
 * catalogue size: releases, tracks, saves, track inclusions, release
 * inclusions (plus the follower count).
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
    const orderedReleases = orderReleasesForStats(
      await this.releases.find({ where: { subprofileId } }),
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
    return {
      subprofileId: persona.id,
      followerCount: followerCounts.get(persona.id) ?? 0,
      releases: orderedReleases.map((release) => {
        const tracksOfRelease = releaseTracks.filter(
          (track) => track.releaseId === release.id,
        );
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
          tracks: tracksOfRelease.map((track) => ({
            track: toStudioTrackSummary(track),
            saves: toStudioCount(saves.byTrackId.get(track.id) ?? 0),
            playlistInclusions: toStudioCount(
              trackInclusions.get(track.id) ?? 0,
            ),
          })),
        };
      }),
    };
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
}
