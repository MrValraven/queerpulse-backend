import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import { CreateStudioTrackDto } from './dto/create-studio-track.dto';
import { ReorderStudioTracksDto } from './dto/reorder-studio-tracks.dto';
import { UpdateStudioTrackDto } from './dto/update-studio-track.dto';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioReleaseResponse, StudioTrackResponse } from './studio-response';
import { STUDIO_LIMITS, studioError } from './studio.constants';

/** Whether a requested order names every current track exactly once. */
export function isSameTrackSet(
  currentTrackIds: string[],
  requestedTrackIds: string[],
): boolean {
  if (currentTrackIds.length !== requestedTrackIds.length) {
    return false;
  }
  const requestedSet = new Set(requestedTrackIds);
  return (
    requestedSet.size === requestedTrackIds.length &&
    currentTrackIds.every((trackId) => requestedSet.has(trackId))
  );
}

function assertDraft(release: StudioRelease): void {
  if (release.status !== StudioReleaseStatus.Draft) {
    throw studioError('studio_release_not_draft');
  }
}

/**
 * Studio v1 track writes. Each runs in one transaction that locks the
 * release row first, so writes to one release are serialized: a reorder
 * queued behind a delete reads the shorter list and answers a mismatch.
 * Positions stay 1-based and contiguous: an add appends, a delete closes the
 * gap and a reorder rewrites them, each move in a single `UPDATE`, which the
 * DEFERRABLE INITIALLY IMMEDIATE unique constraint checks at statement end.
 */
@Injectable()
export class StudioTracksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly studioAudioUploads: StudioAudioUploadsService,
  ) {}

  async create(
    userId: string,
    releaseId: string,
    body: CreateStudioTrackDto,
  ): Promise<StudioTrackResponse> {
    const trackId = await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      assertDraft(release);
      const trackCount = await manager.count(StudioTrack, {
        where: { releaseId },
      });
      if (trackCount >= STUDIO_LIMITS.tracksPerRelease) {
        throw studioError('studio_track_limit');
      }
      const saved = await manager.save(
        manager.create(StudioTrack, {
          releaseId,
          position: trackCount + 1,
          title: body.title,
          credits: [],
          isExplicit: false,
        }),
      );
      return saved.id;
    });
    return this.catalog.getTrack(userId, trackId);
  }

  /** Drafts and published releases; a taken-down release stays frozen. */
  async update(
    userId: string,
    trackId: string,
    body: UpdateStudioTrackDto,
  ): Promise<StudioTrackResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { track, release } = await this.lockTrackForWrite(
        manager,
        userId,
        trackId,
      );
      if (release.status === StudioReleaseStatus.TakenDown) {
        throw studioError('studio_release_not_draft');
      }
      if (body.title !== undefined) {
        track.title = body.title;
      }
      if (body.credits !== undefined) {
        track.credits = body.credits.map(({ name, role }) => ({ name, role }));
      }
      if (body.lyrics !== undefined) {
        track.lyrics = body.lyrics && body.lyrics.trim() ? body.lyrics : null;
      }
      if (body.isExplicit !== undefined) {
        track.isExplicit = body.isExplicit;
      }
      await manager.save(track);
    });
    return this.catalog.getTrack(userId, trackId);
  }

  async remove(userId: string, trackId: string): Promise<void> {
    const audioKey = await this.dataSource.transaction(async (manager) => {
      const { track, release } = await this.lockTrackForWrite(
        manager,
        userId,
        trackId,
      );
      assertDraft(release);
      await manager.delete(StudioTrack, { id: track.id });
      await manager.query(
        `UPDATE "studio_tracks" SET "position" = "position" - 1 WHERE "release_id" = $1 AND "position" > $2`,
        [release.id, track.position],
      );
      return track.audioKey;
    });
    if (audioKey) {
      await this.studioAudioUploads.deleteObjectsAndForget([audioKey]);
    }
  }

  async reorder(
    userId: string,
    releaseId: string,
    body: ReorderStudioTracksDto,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      assertDraft(release);
      const currentTracks = await manager.find(StudioTrack, {
        where: { releaseId },
        select: { id: true },
      });
      if (
        !isSameTrackSet(
          currentTracks.map((track) => track.id),
          body.trackIds,
        )
      ) {
        throw studioError('studio_track_order_mismatch');
      }
      await manager.query(
        `UPDATE "studio_tracks" AS "track" SET "position" = "ordering"."position"
           FROM unnest($2::uuid[], $3::smallint[]) AS "ordering"("track_id", "position")
          WHERE "track"."id" = "ordering"."track_id" AND "track"."release_id" = $1`,
        [
          releaseId,
          body.trackIds,
          body.trackIds.map((_trackId, index) => index + 1),
        ],
      );
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  // Reads the track's release id, locks that release, then re-reads the
  // track under the lock, so a delete or a move committed first is seen.
  private async lockTrackForWrite(
    manager: EntityManager,
    userId: string,
    trackId: string,
  ): Promise<{ track: StudioTrack; release: StudioRelease }> {
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
    return { track, release };
  }
}
