import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  isStudioPreviewToken,
  mintStudioPreviewToken,
} from './studio-preview-token';
import {
  StudioPreviewLink,
  StudioPreviewResult,
  StudioStream,
  hasPlayableAudio,
  toStudioStream,
} from './studio-response';
import { previewablePersonaSql } from './studio-visibility';
import { studioError } from './studio.constants';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Studio v3 private preview links. One link per draft or scheduled
 * release; a new one replaces the old; the token is stored as minted so the
 * owner can copy the link again (the saved-list share pattern). Any
 * granted member holding the link can open it. Every failure on the read
 * routes is the same 404, so a token never tells revoked from unknown from
 * blocked. Nothing records who opened a link or how often, and the request
 * log, metrics and Sentry skip `/studio/previews/` (`studio-request-log.ts`).
 */
@Injectable()
export class StudioPreviewsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly blockFilter: BlockFilterService,
    private readonly storage: StorageService,
  ) {}

  async mintLink(
    userId: string,
    releaseId: string,
  ): Promise<StudioPreviewLink> {
    return this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (
        release.status !== StudioReleaseStatus.Draft &&
        release.status !== StudioReleaseStatus.Scheduled
      ) {
        throw studioError('studio_preview_not_available');
      }
      const token = mintStudioPreviewToken();
      const createdAt = new Date();
      release.previewToken = token;
      release.previewLinkCreatedAt = createdAt;
      await manager.save(release);
      return { token, createdAt: createdAt.toISOString() };
    });
  }

  /** Idempotent, on any release the caller may write. */
  async revokeLink(userId: string, releaseId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (
        release.previewToken === null &&
        release.previewLinkCreatedAt === null
      ) {
        return;
      }
      release.previewToken = null;
      release.previewLinkCreatedAt = null;
      await manager.save(release);
    });
  }

  async getPreview(
    viewerId: string,
    token: string,
  ): Promise<StudioPreviewResult> {
    const release = await this.resolveToken(viewerId, token);
    if (release.status === StudioReleaseStatus.Published) {
      return { release: null, publishedReleaseId: release.id };
    }
    try {
      return {
        release: await this.catalog.getReleaseAsPreview(viewerId, release.id),
        publishedReleaseId: null,
      };
    } catch (error) {
      // The row can vanish or be withdrawn between the token lookup and the
      // read; every client refusal answers the same 404 body as every other
      // preview failure.
      if (error instanceof HttpException && error.getStatus() < 500) {
        throw studioError('studio_preview_not_found');
      }
      throw error;
    }
  }

  async getPreviewStream(
    viewerId: string,
    token: string,
    trackId: string,
  ): Promise<StudioStream> {
    const release = await this.resolveToken(viewerId, token);
    if (
      release.status === StudioReleaseStatus.Published ||
      !UUID_PATTERN.test(trackId)
    ) {
      throw studioError('studio_preview_not_found');
    }
    const track = await this.tracks.findOne({
      where: { id: trackId.toLowerCase(), releaseId: release.id },
    });
    if (
      !track ||
      !hasPlayableAudio(track) ||
      !track.audioKey ||
      !track.audioContentType
    ) {
      throw studioError('studio_preview_not_found');
    }
    const signedStream = await this.storage.createPresignedAudioStream(
      track.audioKey,
      track.audioContentType,
      track.durationSeconds,
    );
    return toStudioStream(signedStream, track);
  }

  /** The release behind a token, while it is a draft, scheduled or
   *  published, its persona is neither removed nor taken down, and its
   *  creator is not blocked either way with the caller. */
  private async resolveToken(
    viewerId: string,
    token: string,
  ): Promise<StudioRelease> {
    if (!isStudioPreviewToken(token)) {
      throw studioError('studio_preview_not_found');
    }
    const queryBuilder = this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .where('"release"."preview_token" = :previewToken', {
        previewToken: token,
      })
      .andWhere('release.status IN (:...previewStatuses)', {
        previewStatuses: [
          StudioReleaseStatus.Draft,
          StudioReleaseStatus.Scheduled,
          StudioReleaseStatus.Published,
        ],
      })
      .andWhere(previewablePersonaSql('persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const release = await queryBuilder.getOne();
    if (!release || release.status === StudioReleaseStatus.TakenDown) {
      throw studioError('studio_preview_not_found');
    }
    return release;
  }
}
