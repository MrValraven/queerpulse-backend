import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Not } from 'typeorm';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import { CreateStudioTrackDto } from './dto/create-studio-track.dto';
import { ReorderStudioTracksDto } from './dto/reorder-studio-tracks.dto';
import {
  StudioChapterDto,
  UpdateStudioTrackDto,
} from './dto/update-studio-track.dto';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioChapter, StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  assertTrackOrderUnlocked,
  isPodcastRelease,
} from './studio-episode-rule';
import {
  StudioOwnershipService,
  StudioWritablePersona,
} from './studio-ownership.service';
import {
  assertKeepsPlayableTrack,
  assertTracksEditable,
  isLiveOrUpcomingStatus,
  stampTracksChangedIfPublished,
} from './studio-release-edit-rule';
import {
  StudioReleaseResponse,
  StudioTrackResponse,
  hasPlayableAudio,
} from './studio-response';
import {
  assertLyricsWithinFormat,
  notesForTrack,
  sourcesForTrack,
} from './studio-track-content-rule';
import { areChaptersWithinDuration } from './studio-track-listening';
import {
  STUDIO_LIMITS,
  studioError,
  studioFormatForKind,
} from './studio.constants';
import {
  normalizeContentWarnings,
  studioSafetyError,
} from './studio-safety.constants';

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

/**
 * Studio listening: the chapters to store, once each starts inside the
 * track's confirmed audio. A track still uploading has no duration to hold
 * them, so it refuses them too. A blank artist is stored as null.
 */
function chaptersForTrack(
  chapters: StudioChapterDto[],
  track: StudioTrack,
): StudioChapter[] {
  const durationSeconds = hasPlayableAudio(track)
    ? track.durationSeconds
    : null;
  if (!areChaptersWithinDuration(chapters, durationSeconds)) {
    throw studioError('studio_chapters_out_of_range');
  }
  return chapters.map(({ startSeconds, title, artist }) => ({
    startSeconds,
    title,
    artist: artist || null,
  }));
}

/**
 * Studio v1 track writes. Each runs in one transaction that locks the
 * release row first, so writes to one release are serialized: a reorder
 * queued behind a delete reads the shorter list and answers a mismatch.
 * Positions stay 1-based and contiguous: an add appends, a delete closes the
 * gap and a reorder rewrites them, each move in a single `UPDATE`, which the
 * DEFERRABLE INITIALLY IMMEDIATE unique constraint checks at statement end.
 * Studio v3: drafts, scheduled and published releases take track writes (a
 * taken-down release stays frozen); a change to a published release stamps
 * tracks_changed_at, and a live or upcoming release keeps one playable track.
 * Studio artist kinds: a new track on a published show is a draft episode,
 * the show's order is fixed once it is out, and the lyrics cap, show notes
 * and sources follow the persona's format and the release type.
 * Studio safety: a PATCH writes the artist's content warnings and keeps an explicit flag our team locked.
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
      assertTracksEditable(release);
      const trackCount = await manager.count(StudioTrack, {
        where: { releaseId },
      });
      if (isPodcastRelease(release)) {
        if (trackCount >= STUDIO_LIMITS.episodesPerShow) {
          throw studioError('studio_episode_limit');
        }
      } else if (trackCount >= STUDIO_LIMITS.tracksPerRelease) {
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
      await stampTracksChangedIfPublished(manager, release);
      return saved.id;
    });
    return this.catalog.getTrack(userId, trackId);
  }

  /** Drafts, scheduled and published releases; a taken-down release stays frozen.
   *  Chapters are checked against the duration read under the lock. */
  async update(
    userId: string,
    trackId: string,
    body: UpdateStudioTrackDto,
  ): Promise<StudioTrackResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { track, release, persona } = await this.lockTrackForWrite(
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
        const lyrics = body.lyrics && body.lyrics.trim() ? body.lyrics : null;
        // Studio artist kinds: the body takes 60000 characters; a podcast or
        // spoken word transcript keeps them, every other format stops at
        // 10000.
        assertLyricsWithinFormat(lyrics, studioFormatForKind(persona.kind));
        track.lyrics = lyrics;
      }
      if (body.notes !== undefined) {
        track.notes = notesForTrack(body.notes, release);
      }
      if (body.sources !== undefined) {
        track.sources = sourcesForTrack(body.sources, release);
      }
      if (body.isExplicit !== undefined) {
        // Studio safety: our team's explicit mark stays on; asking to keep
        // it on changes nothing.
        if (!body.isExplicit && track.explicitLockedAt) {
          throw studioSafetyError('studio_track_explicit_locked');
        }
        track.isExplicit = body.isExplicit;
      }
      if (body.contentWarnings !== undefined) {
        // Studio safety: the artist list only, once each in theme order.
        track.contentWarnings = normalizeContentWarnings(body.contentWarnings);
      }
      if (body.waveformPeaks !== undefined) {
        track.waveformPeaks =
          body.waveformPeaks === null ? null : [...body.waveformPeaks];
      }
      // The body lets the pair through only together: two numbers or two
      // nulls (`IsPairedWith`), which the pair check in the table mirrors.
      if (body.loudnessLufs !== undefined && body.peakDb !== undefined) {
        track.loudnessLufs = body.loudnessLufs;
        track.peakDb = body.peakDb;
      }
      if (body.syncedLyrics !== undefined) {
        track.syncedLyrics =
          body.syncedLyrics === null
            ? null
            : body.syncedLyrics.map(({ ms, text }) => ({ ms, text }));
      }
      if (body.chapters !== undefined) {
        track.chapters =
          body.chapters === null
            ? null
            : chaptersForTrack(body.chapters, track);
      }
      // Measurements and lyric timings describe the audio; they do not stamp
      // tracks_changed_at, which tells listeners the track list changed.
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
      assertTracksEditable(release);
      if (isLiveOrUpcomingStatus(release.status)) {
        const remainingTracks = await manager.find(StudioTrack, {
          where: { releaseId: release.id, id: Not(track.id) },
          select: {
            id: true,
            audioKey: true,
            durationSeconds: true,
            publishedAt: true,
          },
        });
        assertKeepsPlayableTrack(release, remainingTracks);
      }
      await manager.delete(StudioTrack, { id: track.id });
      await manager.query(
        `UPDATE "studio_tracks" SET "position" = "position" - 1 WHERE "release_id" = $1 AND "position" > $2`,
        [release.id, track.position],
      );
      await stampTracksChangedIfPublished(manager, release);
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
      assertTracksEditable(release);
      // Studio artist kinds: a published show is read by publish time.
      assertTrackOrderUnlocked(release);
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
      await stampTracksChangedIfPublished(manager, release);
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  // Reads the track's release id, locks that release, then re-reads the
  // track under the lock, so a delete or a move committed first is seen.
  private async lockTrackForWrite(
    manager: EntityManager,
    userId: string,
    trackId: string,
  ): Promise<{
    track: StudioTrack;
    release: StudioRelease;
    persona: StudioWritablePersona;
  }> {
    const unlockedTrack = await manager.findOne(StudioTrack, {
      where: { id: trackId },
      select: { id: true, releaseId: true },
    });
    if (!unlockedTrack) {
      throw new NotFoundException('Track not found');
    }
    const { release, persona } = await this.ownership.lockReleaseForWrite(
      manager,
      userId,
      unlockedTrack.releaseId,
    );
    // Studio safety: the track row too, after the release row, so a PATCH
    // and a staff mark-explicit (which locks the track) run one at a time.
    const track = await manager.findOne(StudioTrack, {
      where: { id: trackId, releaseId: release.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!track) {
      throw new NotFoundException('Track not found');
    }
    return { track, release, persona };
  }
}
