import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
  StudioPriceMode,
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioSource, StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { withoutKeysHeldByKeptCopies } from './studio-kept-tracks';
import { StudioOwnershipService } from './studio-ownership.service';
import { stampShowEpisodes } from './studio-episode-rule';
import {
  countPaymentMethods,
  lockPaymentMethodsOf,
  releaseHasPricedTracks,
} from './studio-payment-method-lock';
import { firstUnmetPublishRequirement } from './studio-publish-rule';
import {
  StudioPrice,
  isSellableReleaseType,
  studioPriceShapeRefusal,
  studioTypeChangeRefusal,
} from './studio-purchase-rules';
import { StudioReleaseResponse } from './studio-response';
import { scheduleDateInLisbon } from './studio-schedule-rule';
import {
  isReleaseTypeAllowedForPersonaKind,
  studioDefaultGenresForKind,
  studioError,
} from './studio.constants';
import {
  STUDIO_RELEASE_PUBLISHED,
  StudioReleasePublishedEvent,
} from './studio.events';

/** An uploaded image key a cover may come from: not a message attachment,
 *  and an image extension a persona-scoped copy can carry. */
function isUsableCoverKey(value: string): boolean {
  if (!isStorageKey(value) || isPrivateMessageKey(value)) {
    return false;
  }
  return isPersonaScopedExtension(value.slice(value.lastIndexOf('.')));
}

/** The `price_mode` a PATCH price writes; null takes the release off sale. */
function storedPriceMode(price: StudioPrice | null): StudioPriceMode {
  if (price === null) return StudioPriceMode.NotForSale;
  return price.mode === 'fixed'
    ? StudioPriceMode.Fixed
    : StudioPriceMode.NameYourPrice;
}

/**
 * Studio v1 release writes. Every change after the create runs inside one
 * transaction that first locks the release row
 * (`StudioOwnershipService.lockReleaseForWrite`), which also re-checks
 * membership and the persona kind. Each write answers with the owner view.
 * Studio artist kinds: a show publish stamps its episodes, and edits,
 * lip-sync mixes and mixes publish with every source credited.
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
    private readonly eventEmitter: EventEmitter2,
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
    const presetGenres = studioDefaultGenresForKind(persona.kind);
    const saved = await this.releases.save(
      this.releases.create({
        subprofileId: persona.id,
        title: body.title,
        type: body.type,
        // Studio artist kinds: spoken word releases start in their genre.
        genres: presetGenres,
        genre: presetGenres[0] ?? null,
        status: StudioReleaseStatus.Draft,
      }),
    );
    return this.catalog.getRelease(userId, saved.id);
  }

  /** The credited sources of every track with audio, in one read, for the
   *  publish checklist. Owner only (the write check also answers 404 to a
   *  stranger). */
  async trackSources(
    userId: string,
    releaseId: string,
  ): Promise<{ tracks: { trackId: string; sources: StudioSource[] }[] }> {
    await this.ownership.loadReleaseForWrite(userId, releaseId);
    const releaseTracks = await this.dataSource
      .getRepository(StudioTrack)
      .find({
        where: { releaseId },
        order: { position: 'ASC' },
        select: { id: true, audioKey: true, sources: true },
      });
    return {
      tracks: releaseTracks
        .filter((track) => track.audioKey)
        .map((track) => ({ trackId: track.id, sources: track.sources ?? [] })),
    };
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
      // A published or scheduled release keeps the cover the publish rule
      // required, so clearing it is refused before any field changes.
      if (
        (release.status === StudioReleaseStatus.Published ||
          release.status === StudioReleaseStatus.Scheduled) &&
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
      if (body.genres !== undefined) {
        release.genres = body.genres;
        // The `genre` column mirrors the lead genre; nothing else writes it.
        release.genre = body.genres[0] ?? null;
      }
      if (body.mood !== undefined) {
        release.mood = body.mood;
      }
      if (body.sceneId !== undefined) {
        release.sceneId = await this.resolveSceneId(
          manager,
          release,
          body.sceneId,
        );
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
      if (body.buyUrl !== undefined) {
        release.buyUrl = body.buyUrl || null;
      }
      if (body.isGapless !== undefined) {
        release.isGapless = body.isGapless;
      }
      // Studio purchases (contract 2.1): the release lock is held; the
      // payment-methods lock comes second, so a price never lands on a
      // persona whose last method is going.
      const releaseTypeAfterWrite = release.type;
      if (body.price) {
        const priceRefusal = studioPriceShapeRefusal(
          body.price,
          releaseTypeAfterWrite,
        );
        if (priceRefusal) {
          throw studioError(priceRefusal);
        }
        await lockPaymentMethodsOf(manager, release.subprofileId);
        if ((await countPaymentMethods(manager, release.subprofileId)) === 0) {
          throw studioError('studio_payment_methods_needed_for_sale');
        }
      }
      const isPricedAfterWrite =
        body.price === undefined
          ? (release.priceMode ?? StudioPriceMode.NotForSale) !==
            StudioPriceMode.NotForSale
          : body.price !== null;
      // A type change to a sellable type always passes, so only a change to
      // an unsellable type reads the track prices.
      if (
        body.type !== undefined &&
        !isSellableReleaseType(releaseTypeAfterWrite)
      ) {
        const typeChangeRefusal = studioTypeChangeRefusal({
          isTypeChanging: true,
          releaseTypeAfterWrite,
          hasPricedItemsAfterWrite:
            isPricedAfterWrite ||
            (await releaseHasPricedTracks(manager, release.id, null)),
        });
        if (typeChangeRefusal) {
          throw studioError(typeChangeRefusal);
        }
      }
      if (body.price !== undefined) {
        release.priceMode = storedPriceMode(body.price);
        release.priceCents = body.price?.amountCents ?? null;
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
    // A kept copy still reading a key keeps that object; the orphan sweep
    // reclaims it once the copy lands.
    const deletableKeys = await withoutKeysHeldByKeptCopies(
      this.dataSource,
      audioKeys,
    );
    await this.studioAudioUploads.deleteObjectsAndForget(deletableKeys);
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
      // Studio v3: "Publish now" also takes a scheduled release.
      if (
        release.status !== StudioReleaseStatus.Draft &&
        release.status !== StudioReleaseStatus.Scheduled
      ) {
        throw studioError('studio_release_not_draft');
      }
      const releaseTracks = await manager.find(StudioTrack, {
        where: { releaseId },
        select: {
          id: true,
          audioKey: true,
          durationSeconds: true,
          sources: true,
        },
      });
      const unmetRequirement = firstUnmetPublishRequirement(
        release,
        releaseTracks,
      );
      if (unmetRequirement) {
        throw studioError(unmetRequirement);
      }
      const publishedAt = new Date();
      // A release date that scheduling filled in names the scheduled day;
      // publishing early moves it to the Lisbon day of the publish. A typed
      // date stays.
      if (
        release.publishAt &&
        release.releasedOn === scheduleDateInLisbon(release.publishAt)
      ) {
        release.releasedOn = scheduleDateInLisbon(publishedAt);
      }
      release.status = StudioReleaseStatus.Published;
      release.publishedAt = publishedAt;
      release.publishAt = null;
      release.releasedOn ??= scheduleDateInLisbon(publishedAt);
      await manager.save(release);
      // Studio artist kinds: a show's episodes come out with it, claimed for
      // the release alert, so none of them alerts again. An episode stamped
      // by an earlier publish keeps its first time.
      await stampShowEpisodes(manager, release, publishedAt);
    });
    // Studio v2: after the commit, so the alert listener never reads a
    // publish that could still roll back. Followers hear only on the first
    // publish (the listener claims `followers_notified_at` once); members
    // who set "Notify me" since are alerted and pre-saved on a later drop.
    this.eventEmitter.emit(STUDIO_RELEASE_PUBLISHED, {
      releaseId,
    } satisfies StudioReleasePublishedEvent);
    return this.catalog.getRelease(userId, releaseId);
  }

  /** Back to draft, clearing `published_at` (a later publish stamps a fresh
   *  one). A draft or a scheduled release comes back unchanged (unschedule is
   *  its own route); a taken-down release stays with staff. */
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
        // A preview link handed out before publishing stops working once the
        // release is back in draft; the owner mints a fresh one when needed.
        release.previewToken = null;
        release.previewLinkCreatedAt = null;
        await manager.save(release);
      }
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  // The scene the release should store for `sceneId`: null leaves the
  // scene, the release's own scene stays (even once archived, so an edit
  // that resends it keeps working), and anything else must be an active
  // scene. The stored id is used, so a link in other letter case changes
  // nothing.
  private async resolveSceneId(
    manager: EntityManager,
    release: StudioRelease,
    sceneId: string | null,
  ): Promise<string | null> {
    if (sceneId === null) {
      return null;
    }
    if (
      release.sceneId &&
      release.sceneId.toLowerCase() === sceneId.toLowerCase()
    ) {
      return release.sceneId;
    }
    const scene = await manager.findOne(StudioScene, {
      where: { id: sceneId, status: StudioSceneState.Active },
      select: { id: true },
    });
    if (!scene) {
      throw studioError('studio_scene_not_available');
    }
    return scene.id;
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
