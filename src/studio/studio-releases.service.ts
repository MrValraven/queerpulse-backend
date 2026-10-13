import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { assertNoForeignUploadIntroducedForPersona } from '../storage/assert-no-foreign-upload';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { isPersonaScopedExtension, isStorageKey } from '../storage/storage-key';
import { StudioAudioUploadsService } from '../storage/studio-audio-uploads.service';
import { isPrivateMessageKey } from '../storage/upload-kinds';
import { CreateStudioReleaseDto } from './dto/create-studio-release.dto';
import { UpdateStudioReleaseDto } from './dto/update-studio-release.dto';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { firstUnmetPublishRequirement, toIsoDate } from './studio-publish-rule';
import { StudioReleaseResponse } from './studio-response';
import {
  isReleaseTypeAllowedForPersonaKind,
  studioError,
} from './studio.constants';

/** An uploaded image key a cover may come from: not a message attachment,
 *  and an image extension a persona-scoped copy can carry. */
function isUsableCoverKey(value: string): boolean {
  if (!isStorageKey(value) || isPrivateMessageKey(value)) {
    return false;
  }
  return isPersonaScopedExtension(value.slice(value.lastIndexOf('.')));
}

/**
 * Studio v1 release writes. Every change after the create runs inside one
 * transaction that first locks the release row
 * (`StudioOwnershipService.lockReleaseForWrite`), which also re-checks
 * membership and the persona kind. Each write answers with the owner view.
 */
@Injectable()
export class StudioReleasesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly personaImageKeys: PersonaImageKeysService,
    private readonly studioAudioUploads: StudioAudioUploadsService,
  ) {}

  async create(
    userId: string,
    body: CreateStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    const persona = await this.ownership.assertArtistPersona(
      userId,
      body.subprofileId,
    );
    if (!isReleaseTypeAllowedForPersonaKind(body.type, persona.kind)) {
      throw studioError('studio_release_type_mismatch');
    }
    const saved = await this.releases.save(
      this.releases.create({
        subprofileId: persona.id,
        title: body.title,
        type: body.type,
        status: StudioReleaseStatus.Draft,
      }),
    );
    return this.catalog.getRelease(userId, saved.id);
  }

  async update(
    userId: string,
    releaseId: string,
    body: UpdateStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release, persona } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status === StudioReleaseStatus.TakenDown) {
        throw studioError('studio_release_not_draft');
      }
      // A published release keeps the cover the publish rule required, so
      // clearing it is refused before any field changes.
      if (
        release.status === StudioReleaseStatus.Published &&
        body.coverKey === null
      ) {
        throw studioError('studio_publish_missing_cover');
      }
      if (body.type !== undefined) {
        if (!isReleaseTypeAllowedForPersonaKind(body.type, persona.kind)) {
          throw studioError('studio_release_type_mismatch');
        }
        release.type = body.type;
      }
      if (body.title !== undefined) {
        release.title = body.title;
      }
      if (body.description !== undefined) {
        release.description = body.description?.trim() || null;
      }
      if (body.genre !== undefined) {
        release.genre = body.genre;
      }
      if (body.releasedOn !== undefined) {
        release.releasedOn = body.releasedOn;
      }
      if (body.coverKey !== undefined) {
        release.coverKey = await this.resolveCoverKey(
          manager,
          userId,
          release,
          body.coverKey,
        );
      }
      if (body.rightsConfirmed === true && !release.rightsConfirmedAt) {
        release.rightsConfirmedAt = new Date();
      }
      await manager.save(release);
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  /** Drafts only. Tracks go with the release (foreign key cascade); their
   *  audio objects are deleted once the delete has committed. */
  async remove(userId: string, releaseId: string): Promise<void> {
    const audioKeys = await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status !== StudioReleaseStatus.Draft) {
        throw studioError('studio_release_not_draft');
      }
      const releaseTracks = await manager.find(StudioTrack, {
        where: { releaseId },
        select: { id: true, audioKey: true },
      });
      await manager.delete(StudioRelease, { id: releaseId });
      return releaseTracks.flatMap((track) =>
        track.audioKey ? [track.audioKey] : [],
      );
    });
    await this.studioAudioUploads.deleteObjectsAndForget(audioKeys);
  }

  async publish(
    userId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status !== StudioReleaseStatus.Draft) {
        throw studioError('studio_release_not_draft');
      }
      const releaseTracks = await manager.find(StudioTrack, {
        where: { releaseId },
        select: { id: true, audioKey: true, durationSeconds: true },
      });
      const unmetRequirement = firstUnmetPublishRequirement(
        release,
        releaseTracks,
      );
      if (unmetRequirement) {
        throw studioError(unmetRequirement);
      }
      const publishedAt = new Date();
      release.status = StudioReleaseStatus.Published;
      release.publishedAt = publishedAt;
      release.releasedOn ??= toIsoDate(publishedAt);
      await manager.save(release);
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  /** Back to draft, clearing `published_at` (a later publish stamps a fresh
   *  one). A draft comes back unchanged; a taken-down release stays with staff. */
  async unpublish(
    userId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status === StudioReleaseStatus.TakenDown) {
        throw studioError('studio_release_not_draft');
      }
      if (release.status === StudioReleaseStatus.Published) {
        release.status = StudioReleaseStatus.Draft;
        release.publishedAt = null;
        await manager.save(release);
      }
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  // The cover the release should store for `coverKey`: null clears, the
  // stored key stays as it is, and anything else must be an image the
  // caller uploaded (or one of a persona they co-own), copied to a
  // persona-scoped key registered to this release's persona, so no cover
  // path names a member.
  private async resolveCoverKey(
    manager: EntityManager,
    userId: string,
    release: StudioRelease,
    coverKey: string | null,
  ): Promise<string | null> {
    if (coverKey === null) {
      return null;
    }
    if (coverKey === release.coverKey) {
      return coverKey;
    }
    if (!isUsableCoverKey(coverKey)) {
      throw new BadRequestException('coverKey must be an uploaded image');
    }
    await assertNoForeignUploadIntroducedForPersona(
      userId,
      coverKey,
      [release.coverKey],
      (storageKey, memberUserId) =>
        this.personaImageKeys.isMemberOfKeyPersona(storageKey, memberUserId),
    );
    const rehomed = await this.personaImageKeys.rehomeKeys(
      manager,
      release.subprofileId,
      [coverKey],
      { shouldCopyMemberScoped: true, personaScopedMode: 'keep-own' },
    );
    if (!rehomed.has(coverKey)) {
      return coverKey;
    }
    const freshKey = rehomed.get(coverKey) ?? null;
    if (freshKey === null) {
      throw new BadRequestException('The cover upload could not be found');
    }
    return freshKey;
  }
}
