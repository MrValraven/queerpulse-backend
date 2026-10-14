import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StudioReleaseType } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import { assertEpisodePublishable } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { playableTrackSql } from './studio-playlist-visibility';
import {
  StudioReleaseCard,
  StudioTrackResponse,
  toStudioTrackResponse,
} from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';
import {
  STUDIO_EPISODE_PUBLISHED,
  StudioEpisodePublishedEvent,
} from './studio.events';

/** One card of the "New episodes" shelf. */
export interface StudioEpisodeFeedItem {
  track: StudioTrackResponse;
  release: StudioReleaseCard;
}

/** `GET /studio/episodes/latest`. */
export interface StudioEpisodeFeed {
  items: StudioEpisodeFeedItem[];
  nextCursor: string | null;
}

/**
 * Studio artist kinds: one episode's publish, and the newest published
 * episodes across the shows a viewer can hear. The publish runs under the
 * show's row lock (`lockReleaseForWrite`, which checks membership and the
 * persona kind) and emits `STUDIO_EPISODE_PUBLISHED` after the commit for
 * `StudioEpisodeAlertsListener`. The feed reads through `playableTrackSql`,
 * whose arm keeps draft episodes out, with the block filter on the persona
 * creator. Nothing here records who listens.
 */
@Injectable()
export class StudioEpisodesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** `POST /studio/tracks/:id/publish`: a draft episode of a published show
   *  comes out now. Answers the owner view of the episode. */
  async publishEpisode(
    userId: string,
    trackId: string,
  ): Promise<StudioTrackResponse> {
    await this.dataSource.transaction(async (manager) => {
      const unlockedTrack = await manager.findOne(StudioTrack, {
        where: { id: trackId },
        select: { id: true, releaseId: true },
      });
      if (!unlockedTrack) {
        throw new NotFoundException('Track not found');
      }
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        unlockedTrack.releaseId,
      );
      const track = await manager.findOne(StudioTrack, {
        where: { id: trackId, releaseId: release.id },
      });
      if (!track) {
        throw new NotFoundException('Track not found');
      }
      assertEpisodePublishable(release, track);
      // A JS Date holds milliseconds, the column's own precision. A show's
      // version tools stay off: nothing stamps `tracks_changed_at`.
      track.publishedAt = new Date();
      await manager.save(track);
    });
    this.eventEmitter.emit(STUDIO_EPISODE_PUBLISHED, {
      trackId,
    } satisfies StudioEpisodePublishedEvent);
    return this.catalog.getTrack(userId, trackId);
  }

  /** The newest published episodes, `published_at desc, id desc`. A feed
   *  item leaves the transcript, the timed lyrics and the credits (free-text
   *  and persona credits) on the episode page. */
  async listLatest(
    viewerId: string,
    cursor: string | undefined,
    limit: number = STUDIO_LIMITS.episodesPerPage,
  ): Promise<StudioEpisodeFeed> {
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .where('"release"."type" = :podcastType', {
        podcastType: StudioReleaseType.Podcast,
      })
      .andWhere('"track"."published_at" IS NOT NULL')
      .andWhere(playableTrackSql('track', 'release', 'persona'));
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("track"."published_at", "track"."id") < (:cursorPublishedAt, :cursorId)',
        {
          cursorPublishedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const rows = await queryBuilder
      .orderBy('track.publishedAt', 'DESC')
      .addOrderBy('track.id', 'DESC')
      .limit(limit + 1)
      .getMany();
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const cardsByReleaseId = await this.catalog.cardsByReleaseId([
      ...new Set(pageRows.map((track) => track.releaseId)),
    ]);
    const items = pageRows.flatMap((track): StudioEpisodeFeedItem[] => {
      const releaseCard = cardsByReleaseId.get(track.releaseId);
      return releaseCard
        ? [
            {
              track: {
                ...toStudioTrackResponse(track, releaseCard),
                lyrics: null,
                syncedLyrics: null,
                credits: [],
              },
              release: releaseCard,
            },
          ]
        : [];
    });
    const lastTrack = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor:
        hasMore && lastTrack?.publishedAt
          ? encodeStudioCursor({
              publishedAt: lastTrack.publishedAt,
              id: lastTrack.id,
            })
          : null,
    };
  }
}
