import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Readable } from 'node:stream';
import { DataSource, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { studioAudioContentTypeForKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  STUDIO_AUDIO_PARSE_TIMEOUT_MILLISECONDS,
  classifyStudioAudio,
  readStudioAudioFactsWithin,
} from './studio-audio-metadata';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioTrackResponse } from './studio-response';
import {
  STUDIO_LIMITS,
  StudioAudioContentType,
  isStudioAudioContentType,
  studioError,
} from './studio.constants';

/** The partial unique index on `studio_tracks.audio_key` (one object backs
 *  one track). */
const STUDIO_TRACK_AUDIO_KEY_CONSTRAINT = 'UQ_studio_tracks_audio_key';

/**
 * Studio v1: `POST /studio/tracks/:id/audio`. Two phases, so no row lock is
 * held during the read of a file up to 50 MB:
 *
 * 1. Without a lock: the caller may write the release, the key is registered
 *    to this release's persona and held by no other track, `HeadObject`
 *    agrees with the key's extension and the cap, and `music-metadata`
 *    reads a duration from a streamed read of the object.
 * 2. Under the release lock: membership, the draft state and the track are
 *    checked again, then the track is updated.
 *
 * An object that fails the read, or whose write is refused in phase 2, is
 * deleted unless a committed track already references it (a retried confirm
 * or a parallel one may have attached it first). A refusal in phase 1 before
 * the read leaves the object alone (the key came from the caller); the orphan
 * sweep reclaims it if no track ever references it. An error from the bucket
 * itself, or a database failure in phase 2, propagates and leaves the object
 * alone, so a retried confirm can use the same key. A save that loses the race
 * for the key to another track answers `studio_audio_wrong_owner` and keeps
 * the object, which that track now holds. A replaced object is deleted after
 * the commit.
 */
@Injectable()
export class StudioAudioConfirmService {
  private readonly logger = new Logger(StudioAudioConfirmService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly storage: StorageService,
    private readonly studioAudioUploads: StudioAudioUploadsService,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
  ) {}

  async confirm(
    userId: string,
    trackId: string,
    key: string,
  ): Promise<StudioTrackResponse> {
    const track = await this.tracks.findOne({ where: { id: trackId } });
    if (!track) {
      throw new NotFoundException('Track not found');
    }
    const { release } = await this.ownership.loadReleaseForWrite(
      userId,
      track.releaseId,
    );
    if (release.status !== StudioReleaseStatus.Draft) {
      throw studioError('studio_release_not_draft');
    }
    if (track.audioKey === key) {
      return this.catalog.getTrack(userId, trackId);
    }
    await this.assertKeyBelongsTo(key, release.subprofileId, trackId);
    const declaredContentType = studioAudioContentTypeForKey(key);
    if (
      !declaredContentType ||
      !isStudioAudioContentType(declaredContentType)
    ) {
      throw studioError('studio_audio_wrong_owner');
    }
    const byteSize = await this.storedSizeOf(key, declaredContentType);
    const durationSeconds = await this.readDuration(
      key,
      declaredContentType,
      byteSize,
    );
    if (durationSeconds === null) {
      await this.discard(key);
      throw studioError('studio_audio_unreadable');
    }

    let replacedKey: string | null;
    try {
      replacedKey = await this.dataSource.transaction(async (manager) => {
        const { release: lockedRelease } =
          await this.ownership.lockReleaseForWrite(
            manager,
            userId,
            track.releaseId,
          );
        if (lockedRelease.status !== StudioReleaseStatus.Draft) {
          throw studioError('studio_release_not_draft');
        }
        const lockedTrack = await manager.findOne(StudioTrack, {
          where: { id: trackId, releaseId: lockedRelease.id },
        });
        if (!lockedTrack) {
          throw new NotFoundException('Track not found');
        }
        const previousKey = lockedTrack.audioKey;
        lockedTrack.audioKey = key;
        lockedTrack.audioContentType = declaredContentType;
        lockedTrack.audioBytes = byteSize;
        lockedTrack.durationSeconds = durationSeconds;
        await manager.save(lockedTrack);
        return previousKey;
      });
    } catch (error) {
      if (isUniqueViolation(error, STUDIO_TRACK_AUDIO_KEY_CONSTRAINT)) {
        throw studioError('studio_audio_wrong_owner');
      }
      // Only a refusal discards the object. A database failure (deadlock,
      // lost connection) keeps it, so the member can retry with the same key.
      if (error instanceof HttpException) {
        await this.discard(key);
      }
      throw error;
    }
    if (replacedKey && replacedKey !== key) {
      await this.studioAudioUploads.deleteObjectsAndForget([replacedKey]);
    }
    return this.catalog.getTrack(userId, trackId);
  }

  private async assertKeyBelongsTo(
    key: string,
    subprofileId: string,
    trackId: string,
  ): Promise<void> {
    const registration = await this.studioAudioUploads.findRegistration(key);
    if (!registration || registration.subprofileId !== subprofileId) {
      throw studioError('studio_audio_wrong_owner');
    }
    const isHeldByAnotherTrack = await this.tracks.exists({
      where: { audioKey: key, id: Not(trackId) },
    });
    if (isHeldByAnotherTrack) {
      throw studioError('studio_audio_wrong_owner');
    }
  }

  // The stored size, once `HeadObject` confirms the object exists with the
  // content type the presign pinned and a size within the cap.
  private async storedSizeOf(
    key: string,
    declaredContentType: StudioAudioContentType,
  ): Promise<number> {
    let head: { contentType: string | null; contentLength: number | null };
    try {
      head = await this.storage.headObject(key);
    } catch (error) {
      if (StorageService.isMissingObjectError(error)) {
        throw studioError('studio_audio_unreadable');
      }
      throw error;
    }
    const contentLength = head.contentLength ?? 0;
    const isWithinCap =
      contentLength > 0 && contentLength <= STUDIO_LIMITS.audioMaxBytes;
    if (head.contentType !== declaredContentType || !isWithinCap) {
      await this.discard(key);
      throw studioError('studio_audio_unreadable');
    }
    return contentLength;
  }

  // The duration in whole seconds, or null when the bytes are not the audio
  // the key promises (or the parse fails or times out). An error opening the
  // object is the bucket's, so it propagates and the object stays.
  private async readDuration(
    key: string,
    declaredContentType: StudioAudioContentType,
    byteSize: number,
  ): Promise<number | null> {
    const stream: Readable = await this.storage.openObjectStream(key);
    try {
      const facts = await readStudioAudioFactsWithin(
        stream,
        byteSize,
        STUDIO_AUDIO_PARSE_TIMEOUT_MILLISECONDS,
      );
      const verdict = classifyStudioAudio(facts, declaredContentType);
      return verdict.isReadable ? verdict.durationSeconds : null;
    } catch (error) {
      this.logger.warn(
        `A Studio audio file could not be read: ${String(error)}`,
      );
      return null;
    } finally {
      stream.destroy();
    }
  }

  // Reads committed rows through the repository, outside any rolled-back
  // transaction, so an object a track already holds is kept.
  private async discard(key: string): Promise<void> {
    const isReferencedByATrack = await this.tracks.exists({
      where: { audioKey: key },
    });
    if (isReferencedByATrack) {
      return;
    }
    await this.studioAudioUploads.deleteObjectsAndForget([key]);
  }
}
