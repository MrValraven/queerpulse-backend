import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { UpdateStudioPressKitDto } from './dto/update-studio-press-kit.dto';
import { StudioPressKit } from './entities/studio-press-kit.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { episodeReleasedSql } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { notWithheldTrackSql } from './studio-playlist-visibility';
import {
  StudioPressFeaturedTrack,
  StudioPressKitResponse,
  toStudioPressKitResponse,
} from './studio-press-kit-response';
import { toStudioTrackSummary } from './studio-response';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_PRESS,
  isStudioArtistPersonaKind,
  studioError,
} from './studio.constants';

/** An empty string clears a press kit text field. */
function textOrNull(value: string | null): string | null {
  return value && value.trim() ? value : null;
}

/**
 * Studio v3 press kit. Granted members read it while the persona is
 * listenable to them, owners always; Studio artist kinds only. Best
 * tracks are published tracks with confirmed audio, in the chosen order,
 * or the newest five when none are chosen. Nothing counts a read, and the
 * request log, metrics and Sentry skip the route (`studio-request-log.ts`).
 */
@Injectable()
export class StudioPressKitService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(StudioPressKit)
    private readonly pressKits: Repository<StudioPressKit>,
    @InjectRepository(SubprofileSocialLink)
    private readonly socialLinks: Repository<SubprofileSocialLink>,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async getPressKit(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioPressKitResponse> {
    const persona = await this.subprofiles.findOne({
      where: { id: subprofileId },
      select: {
        id: true,
        handle: true,
        displayName: true,
        kind: true,
        avatarUrl: true,
        bio: true,
      },
    });
    if (!persona || !isStudioArtistPersonaKind(persona.kind)) {
      throw new NotFoundException('Artist not found');
    }
    const isOwner = await this.ownership.isPersonaMember(viewerId, persona.id);
    if (!isOwner && !(await this.isPersonaListenable(viewerId, persona.id))) {
      throw new NotFoundException('Artist not found');
    }
    const [pressKit, socialLinkRows, latestReleases] = await Promise.all([
      this.pressKits.findOne({ where: { subprofileId: persona.id } }),
      this.socialLinks.find({
        where: { subprofileId: persona.id },
        order: { position: 'ASC', createdAt: 'ASC' },
      }),
      this.releases.find({
        where: {
          subprofileId: persona.id,
          status: StudioReleaseStatus.Published,
        },
        order: { publishedAt: 'DESC', id: 'DESC' },
        take: STUDIO_PRESS.releasesShown,
      }),
    ]);
    const featuredTrackIds = pressKit?.featuredTrackIds ?? [];
    const isFeaturedFallback = featuredTrackIds.length === 0;
    const featuredRows = isFeaturedFallback
      ? await this.fallbackTracks(persona.id)
      : await this.chosenTracks(persona.id, featuredTrackIds);
    const cardsByReleaseId = await this.catalog.cardsByReleaseId([
      ...new Set([
        ...featuredRows.map((track) => track.releaseId),
        ...latestReleases.map((release) => release.id),
      ]),
    ]);
    const featuredTracks: StudioPressFeaturedTrack[] = featuredRows.flatMap(
      (track) => {
        const releaseCard = cardsByReleaseId.get(track.releaseId);
        return releaseCard
          ? [{ ...toStudioTrackSummary(track), release: releaseCard }]
          : [];
      },
    );
    return toStudioPressKitResponse({
      persona,
      pressKit,
      featuredTracks,
      isFeaturedFallback,
      releases: latestReleases.flatMap((release) => {
        const releaseCard = cardsByReleaseId.get(release.id);
        return releaseCard ? [releaseCard] : [];
      }),
      socialLinks: socialLinkRows,
      isOwner,
    });
  }

  /** Owners and co-owners of a Studio artist kind persona (the v1 artist
   *  checks, which answer 403). Every featured id must be a track of one of
   *  this persona's releases, else 422 and nothing is written. */
  async updatePressKit(
    userId: string,
    subprofileId: string,
    body: UpdateStudioPressKitDto,
  ): Promise<StudioPressKitResponse> {
    const persona = await this.ownership.assertArtistPersona(
      userId,
      subprofileId,
    );
    const featuredTrackIds = body.featuredTrackIds.map((trackId) =>
      trackId.toLowerCase(),
    );
    if (featuredTrackIds.length) {
      const ownedRows: { id: string }[] = await this.dataSource.query(
        `SELECT "track"."id"::text AS "id"
           FROM "studio_tracks" "track"
          INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
          WHERE "track"."id" = ANY($1::uuid[])
            AND "release"."subprofile_id" = $2`,
        [featuredTrackIds, persona.id],
      );
      if (ownedRows.length !== featuredTrackIds.length) {
        throw studioError('studio_press_track_not_allowed');
      }
    }
    // One atomic upsert, so two first saves never hit a duplicate key.
    await this.pressKits.upsert(
      {
        subprofileId: persona.id,
        pitch: textOrNull(body.pitch),
        pressBio: textOrNull(body.pressBio),
        featuredTrackIds,
        quotes: body.quotes.map(({ quote, source }) => ({ quote, source })),
        contact: textOrNull(body.contact),
        updatedAt: new Date(),
      },
      ['subprofileId'],
    );
    return this.getPressKit(userId, persona.id);
  }

  // The chosen ids that are still playable, in the stored order.
  private async chosenTracks(
    subprofileId: string,
    featuredTrackIds: string[],
  ): Promise<StudioTrack[]> {
    const rows = await this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .where('track.id IN (:...featuredTrackIds)', { featuredTrackIds })
      .andWhere('release.subprofileId = :subprofileId', { subprofileId })
      .andWhere('release.status = :publishedStatus', {
        publishedStatus: StudioReleaseStatus.Published,
      })
      .andWhere('"track"."audio_key" IS NOT NULL')
      .andWhere('"track"."duration_seconds" IS NOT NULL')
      // Studio artist kinds: a draft episode is never featured.
      .andWhere(episodeReleasedSql('track', 'release'))
      // Studio safety: nor a track a copyright claim holds offline.
      .andWhere(notWithheldTrackSql('track'))
      .getMany();
    const tracksById = new Map(rows.map((track) => [track.id, track]));
    return featuredTrackIds.flatMap((trackId) => {
      const track = tracksById.get(trackId);
      return track ? [track] : [];
    });
  }

  // The first playable tracks of the newest published releases.
  private fallbackTracks(subprofileId: string): Promise<StudioTrack[]> {
    return (
      this.tracks
        .createQueryBuilder('track')
        .innerJoin('track.release', 'release')
        .where('release.subprofileId = :subprofileId', { subprofileId })
        .andWhere('release.status = :publishedStatus', {
          publishedStatus: StudioReleaseStatus.Published,
        })
        .andWhere('"track"."audio_key" IS NOT NULL')
        .andWhere('"track"."duration_seconds" IS NOT NULL')
        // Studio artist kinds: a draft episode is never featured.
        .andWhere(episodeReleasedSql('track', 'release'))
        // Studio safety: nor a track a copyright claim holds offline.
        .andWhere(notWithheldTrackSql('track'))
        .orderBy('release.publishedAt', 'DESC')
        .addOrderBy('release.id', 'DESC')
        .addOrderBy('track.position', 'ASC')
        .limit(STUDIO_PRESS.featuredMax)
        .getMany()
    );
  }

  private isPersonaListenable(
    viewerId: string,
    subprofileId: string,
  ): Promise<boolean> {
    const queryBuilder = this.subprofiles
      .createQueryBuilder('persona')
      .where('persona.id = :subprofileId', { subprofileId })
      .andWhere(listenablePersonaSql('persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder.getExists();
  }
}
