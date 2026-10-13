import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileFollowersService } from '../subprofiles/subprofile-followers.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  EMPTY_RELEASE_STATS,
  StudioArtistRef,
  StudioArtistResponse,
  StudioGenres,
  StudioPage,
  StudioReleaseCard,
  StudioReleaseResponse,
  StudioReleaseStats,
  StudioSearchResult,
  StudioStream,
  StudioTrackResponse,
  hasPlayableAudio,
  toStudioArtistRef,
  toStudioOwnerReleaseCard,
  toStudioReleaseCard,
  toStudioReleaseResponse,
  toStudioTrackResponse,
  toStudioTrackSummary,
} from './studio-response';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  STUDIO_GENRES,
  STUDIO_LIMITS,
  StudioGenre,
  StudioSearchType,
  isStudioArtistPersonaKind,
} from './studio.constants';

/** The persona columns a release card needs, selected through a join. */
const ARTIST_PERSONA_COLUMNS = [
  'persona.id',
  'persona.handle',
  'persona.displayName',
  'persona.kind',
  'persona.avatarUrl',
];

interface ReleaseStatsRow {
  release_id: string;
  track_count: number | string;
  total_duration_seconds: number | string;
}

/**
 * Studio v1: every read. Listeners see published releases of listenable
 * personas whose creator is not blocked either way with them
 * (`listenablePersonaSql` plus `BlockFilterService`); owners also read their
 * own drafts and taken-down releases. Queries use `.limit()` because each
 * join here is many-to-one, so a page is never cut through a row set.
 */
@Injectable()
export class StudioCatalogService {
  constructor(
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
    @InjectRepository(StudioTrack)
    private readonly tracks: Repository<StudioTrack>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    private readonly ownership: StudioOwnershipService,
    private readonly blockFilter: BlockFilterService,
    private readonly storage: StorageService,
    private readonly followers: SubprofileFollowersService,
  ) {}

  async listReleases(
    viewerId: string,
    cursor: string | undefined,
    genre?: StudioGenre,
  ): Promise<StudioPage<StudioReleaseCard>> {
    const pageSize = STUDIO_LIMITS.releasesPerPage;
    const queryBuilder = this.listenableReleases(viewerId).addSelect(
      ARTIST_PERSONA_COLUMNS,
    );
    // Studio v2 browse by genre, served by
    // `IDX_studio_releases_genre_published_at`.
    if (genre) {
      queryBuilder.andWhere('"release"."genre" = :studioGenre', {
        studioGenre: genre,
      });
    }
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("release"."published_at", "release"."id") < (:cursorPublishedAt, :cursorId)',
        {
          cursorPublishedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('release.publishedAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastRelease = pageRows[pageRows.length - 1];
    return {
      items: await this.toCards(pageRows),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && lastRelease?.publishedAt
            ? encodeStudioCursor({
                publishedAt: lastRelease.publishedAt,
                id: lastRelease.id,
              })
            : null,
      },
    };
  }

  /**
   * Studio v2: the genres with at least one release this viewer can hear
   * (blocks apply), in `STUDIO_GENRES` order. A genre stored before the list
   * changed is dropped. No counts reach the wire.
   */
  async listGenres(viewerId: string): Promise<StudioGenres> {
    const rows = await this.listenableReleases(viewerId)
      .select('DISTINCT "release"."genre"', 'genre')
      .andWhere('"release"."genre" IS NOT NULL')
      .getRawMany<{ genre: string }>();
    const presentGenres = new Set(rows.map((row) => row.genre));
    return {
      genres: STUDIO_GENRES.filter((genre) => presentGenres.has(genre)),
    };
  }

  /** Releases, tracks and artists. Playlists are merged in by the listening
   *  controller (`StudioPlaylistReadsService.searchPlaylists`), so a
   *  `playlists` search answers empty arrays here. */
  async search(
    viewerId: string,
    query: string,
    type: StudioSearchType,
    genre?: StudioGenre,
  ): Promise<StudioSearchResult> {
    const searchPattern = `%${escapeLikeTerm(query.trim())}%`;
    const [releases, tracks, artists] = await Promise.all([
      type === 'all' || type === 'releases'
        ? this.searchReleases(viewerId, searchPattern, genre)
        : Promise.resolve([]),
      type === 'all' || type === 'tracks'
        ? this.searchTracks(viewerId, searchPattern, genre)
        : Promise.resolve([]),
      type === 'all' || type === 'artists'
        ? this.searchArtists(viewerId, searchPattern)
        : Promise.resolve([]),
    ]);
    return { releases, tracks, artists };
  }

  async getRelease(
    viewerId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    const release = await this.loadReleaseWithPersona(releaseId);
    if (!release?.subprofile) {
      throw new NotFoundException('Release not found');
    }
    const isOwner = await this.ownership.isPersonaMember(
      viewerId,
      release.subprofileId,
    );
    if (!isOwner && !(await this.isReleaseListenable(viewerId, release.id))) {
      throw new NotFoundException('Release not found');
    }
    const tracks = await this.tracks.find({
      where: { releaseId: release.id },
      order: { position: 'ASC' },
    });
    return toStudioReleaseResponse(release, release.subprofile, tracks, {
      isOwner,
      isStaff: false,
    });
  }

  /** Any release in any status, for the admin routes. */
  async getReleaseForStaff(releaseId: string): Promise<StudioReleaseResponse> {
    const release = await this.loadReleaseWithPersona(releaseId);
    if (!release?.subprofile) {
      throw new NotFoundException('Release not found');
    }
    const tracks = await this.tracks.find({
      where: { releaseId: release.id },
      order: { position: 'ASC' },
    });
    return toStudioReleaseResponse(release, release.subprofile, tracks, {
      isOwner: false,
      isStaff: true,
    });
  }

  async getArtist(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioArtistResponse> {
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
    if (!persona) {
      throw new NotFoundException('Artist not found');
    }
    const isOwner = await this.ownership.isPersonaMember(
      viewerId,
      subprofileId,
    );
    const publishedReleases = await this.releases.find({
      where: { subprofileId, status: StudioReleaseStatus.Published },
      order: { publishedAt: 'DESC', id: 'DESC' },
      take: STUDIO_LIMITS.artistReleasesShown,
    });
    if (!isOwner) {
      const isArtist =
        isStudioArtistPersonaKind(persona.kind) || publishedReleases.length > 0;
      if (
        !isArtist ||
        !(await this.isPersonaListenable(viewerId, subprofileId))
      ) {
        throw new NotFoundException('Artist not found');
      }
    }
    const ownerOnlyReleases = isOwner
      ? await this.releases.find({
          where: {
            subprofileId,
            status: In([
              StudioReleaseStatus.Draft,
              StudioReleaseStatus.TakenDown,
            ]),
          },
          order: { updatedAt: 'DESC' },
        })
      : [];
    const statsByReleaseId = await this.statsFor(
      [...publishedReleases, ...ownerOnlyReleases].map((release) => release.id),
    );
    const statsOf = (release: StudioRelease): StudioReleaseStats =>
      statsByReleaseId.get(release.id) ?? EMPTY_RELEASE_STATS;
    // Keyed by the stored id: a link may carry the id in any letter case.
    const [followerCounts, followedPersonaIds] = await Promise.all([
      this.followers.loadFollowerCountsFor([persona.id]),
      this.followers.viewerFollowingFor(viewerId, [persona.id]),
    ]);
    return {
      artist: { ...toStudioArtistRef(persona), bio: persona.bio, city: null },
      releases: publishedReleases.map((release) =>
        toStudioReleaseCard(release, persona, statsOf(release)),
      ),
      ownerReleases: isOwner
        ? ownerOnlyReleases.map((release) =>
            toStudioOwnerReleaseCard(release, persona, statsOf(release)),
          )
        : null,
      followerCount: followerCounts.get(persona.id) ?? 0,
      isFollowing: followedPersonaIds.has(persona.id),
    };
  }

  async getTrack(
    viewerId: string,
    trackId: string,
  ): Promise<StudioTrackResponse> {
    const track = await this.tracks.findOne({ where: { id: trackId } });
    if (!track) {
      throw new NotFoundException('Track not found');
    }
    const release = await this.loadReleaseWithPersona(track.releaseId);
    if (!release?.subprofile) {
      throw new NotFoundException('Track not found');
    }
    const isOwner = await this.ownership.isPersonaMember(
      viewerId,
      release.subprofileId,
    );
    if (!isOwner && !(await this.isReleaseListenable(viewerId, release.id))) {
      throw new NotFoundException('Track not found');
    }
    const stats =
      (await this.statsFor([release.id])).get(release.id) ??
      EMPTY_RELEASE_STATS;
    return toStudioTrackResponse(
      track,
      toStudioReleaseCard(release, release.subprofile, stats),
    );
  }

  /**
   * A 15-minute stream URL. Listeners stream published, listenable releases;
   * owners also stream their drafts; nobody streams a taken-down release.
   * Nothing about the request is recorded.
   */
  async getStream(viewerId: string, trackId: string): Promise<StudioStream> {
    const track = await this.tracks.findOne({ where: { id: trackId } });
    if (!track) {
      throw new NotFoundException('Track not found');
    }
    const release = await this.loadReleaseWithPersona(track.releaseId);
    if (!release || release.status === StudioReleaseStatus.TakenDown) {
      throw new NotFoundException('Track not found');
    }
    const isOwner = await this.ownership.isPersonaMember(
      viewerId,
      release.subprofileId,
    );
    const isAllowed =
      isOwner ||
      (release.status === StudioReleaseStatus.Published &&
        (await this.isReleaseListenable(viewerId, release.id)));
    // `hasPlayableAudio` is the rule behind `hasAudio`, so a track listed
    // without audio never streams; the key check narrows the type.
    if (
      !isAllowed ||
      !hasPlayableAudio(track) ||
      !track.audioKey ||
      !track.audioContentType
    ) {
      throw new NotFoundException('Track not found');
    }
    return this.storage.createPresignedAudioStream(
      track.audioKey,
      track.audioContentType,
    );
  }

  private listenableReleases(
    viewerId: string,
  ): SelectQueryBuilder<StudioRelease> {
    const queryBuilder = this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .where('release.status = :publishedStatus', {
        publishedStatus: StudioReleaseStatus.Published,
      })
      .andWhere(listenablePersonaSql('persona'));
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder;
  }

  private isReleaseListenable(
    viewerId: string,
    releaseId: string,
  ): Promise<boolean> {
    return this.listenableReleases(viewerId)
      .andWhere('release.id = :releaseId', { releaseId })
      .getExists();
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

  private loadReleaseWithPersona(
    releaseId: string,
  ): Promise<StudioRelease | null> {
    return this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .addSelect(ARTIST_PERSONA_COLUMNS)
      .where('release.id = :releaseId', { releaseId })
      .getOne();
  }

  private async searchReleases(
    viewerId: string,
    searchPattern: string,
    genre: StudioGenre | undefined,
  ): Promise<StudioReleaseCard[]> {
    const queryBuilder = this.listenableReleases(viewerId)
      .addSelect(ARTIST_PERSONA_COLUMNS)
      .andWhere(
        `(${foldedHaystack('release', ['title'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\'
          OR ${foldedHaystack('persona', ['display_name'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\')`,
        { studioSearchPattern: searchPattern },
      );
    if (genre) {
      queryBuilder.andWhere('"release"."genre" = :studioGenre', {
        studioGenre: genre,
      });
    }
    const rows = await queryBuilder
      .orderBy('release.publishedAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .limit(STUDIO_LIMITS.searchResultsPerType)
      .getMany();
    return this.toCards(rows);
  }

  private async searchTracks(
    viewerId: string,
    searchPattern: string,
    genre: StudioGenre | undefined,
  ): Promise<StudioSearchResult['tracks']> {
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .where('release.status = :publishedStatus', {
        publishedStatus: StudioReleaseStatus.Published,
      })
      .andWhere(listenablePersonaSql('persona'))
      .andWhere(
        `${foldedHaystack('track', ['title'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\'`,
        { studioSearchPattern: searchPattern },
      )
      .orderBy('release.publishedAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .addOrderBy('track.position', 'ASC')
      .limit(STUDIO_LIMITS.searchResultsPerType);
    if (genre) {
      queryBuilder.andWhere('"release"."genre" = :studioGenre', {
        studioGenre: genre,
      });
    }
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const matchedTracks = await queryBuilder.getMany();
    const cardsByReleaseId = await this.cardsByReleaseId([
      ...new Set(matchedTracks.map((track) => track.releaseId)),
    ]);
    return matchedTracks.flatMap((track) => {
      const releaseCard = cardsByReleaseId.get(track.releaseId);
      return releaseCard
        ? [{ ...toStudioTrackSummary(track), release: releaseCard }]
        : [];
    });
  }

  private async searchArtists(
    viewerId: string,
    searchPattern: string,
  ): Promise<StudioArtistRef[]> {
    const queryBuilder = this.subprofiles
      .createQueryBuilder('persona')
      .select(ARTIST_PERSONA_COLUMNS)
      .where('persona.kind IN (:...artistKinds)', {
        artistKinds: [...STUDIO_ARTIST_PERSONA_KINDS],
      })
      .andWhere(listenablePersonaSql('persona'))
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "studio_releases" "artist_release"
           WHERE "artist_release"."subprofile_id" = "persona"."id"
             AND "artist_release"."status" = :artistReleaseStatus
        )`,
        { artistReleaseStatus: StudioReleaseStatus.Published },
      )
      .andWhere(
        `${foldedHaystack('persona', ['display_name'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\'`,
        { studioSearchPattern: searchPattern },
      )
      .orderBy('persona.displayName', 'ASC')
      .limit(STUDIO_LIMITS.searchResultsPerType);
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return (await queryBuilder.getMany()).map(toStudioArtistRef);
  }

  /** Cards for releases already known to be readable by the caller. Public
   *  for the playlist reads (Studio v2), which check playability first. */
  async cardsByReleaseId(
    releaseIds: string[],
  ): Promise<Map<string, StudioReleaseCard>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows = await this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .addSelect(ARTIST_PERSONA_COLUMNS)
      .where('release.id IN (:...releaseIds)', { releaseIds })
      .getMany();
    const cards = await this.toCards(rows);
    return new Map(cards.map((card) => [card.id, card]));
  }

  private async toCards(rows: StudioRelease[]): Promise<StudioReleaseCard[]> {
    const statsByReleaseId = await this.statsFor(rows.map((row) => row.id));
    return rows.flatMap((row) =>
      row.subprofile
        ? [
            toStudioReleaseCard(
              row,
              row.subprofile,
              statsByReleaseId.get(row.id) ?? EMPTY_RELEASE_STATS,
            ),
          ]
        : [],
    );
  }

  // One grouped query for a whole page of releases.
  private async statsFor(
    releaseIds: string[],
  ): Promise<Map<string, StudioReleaseStats>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows = await this.tracks
      .createQueryBuilder('track')
      .select('"track"."release_id"', 'release_id')
      .addSelect('COUNT(*)::int', 'track_count')
      .addSelect(
        'COALESCE(SUM("track"."duration_seconds") FILTER (WHERE "track"."audio_key" IS NOT NULL), 0)::int',
        'total_duration_seconds',
      )
      .where('"track"."release_id" IN (:...releaseIds)', { releaseIds })
      .groupBy('"track"."release_id"')
      .getRawMany<ReleaseStatsRow>();
    return new Map(
      rows.map((row) => [
        row.release_id,
        {
          trackCount: Number(row.track_count),
          totalDurationSeconds: Number(row.total_duration_seconds),
        },
      ]),
    );
  }
}
