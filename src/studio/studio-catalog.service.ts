import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { runWithConcurrency } from '../common/run-with-concurrency';
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
import { StudioReleaseDispute } from './entities/studio-release-dispute.entity';
import { ownerClaimsForTracks } from './studio-claim-store';
import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import { episodeReleasedSql, isDraftEpisode } from './studio-episode-rule';
import { findGaplessAfterTrackId } from './studio-gapless';
import {
  STUDIO_SEARCH_FIRST_WINDOW,
  StudioSearchSlice,
  StudioSearchWindow,
  nextStudioSearchCursor,
  sliceStudioSearchRows,
  studioSearchRowLimit,
  studioSearchWindowAt,
} from './studio-search-cursor';
import {
  StudioAdminReleaseSummary,
  toStudioAdminReleaseSummary,
} from './studio-dispute-response';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  PublicCreditRow,
  RELEASE_CREDIT_SUMMARY_SQL,
  TRACK_PUBLIC_CREDITS_SQL,
  toPublicTrackCredits,
  toReleaseCreditSummary,
} from './studio-persona-credit-public';
import {
  StudioPersonaCreditPublic,
  StudioReleaseCreditSummary,
} from './studio-persona-credit-response';
import {
  EMPTY_RELEASE_STATS,
  StudioArtistResponse,
  StudioFormats,
  StudioGenres,
  StudioMoods,
  StudioPage,
  StudioReleaseCard,
  StudioReleaseResponse,
  StudioReleaseStats,
  StudioSearchResult,
  StudioStream,
  StudioTrackResponse,
  StudioUpcomingRelease,
  hasPlayableAudio,
  isListenerPlayableTrack,
  isWithheldTrack,
  toListenerTrackSummaries,
  toStudioArtistHeroFields,
  toStudioFormatArtistRef,
  toStudioOwnerReleaseCard,
  toStudioReleaseCard,
  toStudioReleaseResponse,
  toStudioStream,
  toStudioTrackResponse,
  toStudioTrackSummary,
} from './studio-response';
import { StudioReleaseExtrasService } from './studio-release-extras.service';
import { notWithheldTrackSql } from './studio-playlist-visibility';
import { studioSafetyError } from './studio-safety.constants';
import {
  isReleaseWithdrawnForListeners,
  listenablePersonaSql,
} from './studio-visibility';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  STUDIO_FORMATS,
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_MOODS,
  StudioFormat,
  StudioGenre,
  StudioMood,
  StudioSearchType,
  isStudioArtistPersonaKind,
  studioError,
  studioFormatForKind,
  studioPersonaKindsForFormat,
} from './studio.constants';

/** The persona columns a release card needs, selected through a join. */
const ARTIST_PERSONA_COLUMNS = [
  'persona.id',
  'persona.handle',
  'persona.displayName',
  'persona.kind',
  'persona.avatarUrl',
];

/** The scene columns a card needs (Studio discovery), through a left join:
 *  most releases have no scene. */
const CARD_SCENE_COLUMNS = [
  'scene.id',
  'scene.slug',
  'scene.name',
  'scene.status',
];

/** Filters on the listenable release feed. They combine with AND. */
export interface StudioReleaseFilters {
  genre?: StudioGenre;
  mood?: StudioMood;
  /** The scene page (Studio discovery). */
  sceneId?: string;
  /** Studio artist kinds: one format's persona kinds. */
  format?: StudioFormat;
}

interface ReleaseStatsRow {
  release_id: string;
  track_count: number | string;
  playable_track_count: number | string;
  total_duration_seconds: number | string;
  playable_duration_seconds: number | string;
}

/** Studio v3: every count a card may need. Listener cards count playable
 *  tracks; the owner's own rows count every track. */
interface CatalogReleaseStats {
  trackCount: number;
  playableTrackCount: number;
  totalDurationSeconds: number;
  playableDurationSeconds: number;
}

const EMPTY_CATALOG_STATS: CatalogReleaseStats = {
  trackCount: 0,
  playableTrackCount: 0,
  totalDurationSeconds: 0,
  playableDurationSeconds: 0,
};

/** ENG-05: the search types the catalog pages itself. */
export type StudioCatalogSearchType = Exclude<
  StudioSearchType,
  'all' | 'playlists'
>;

const EMPTY_SEARCH_SLICE: StudioSearchSlice<never> = {
  items: [],
  hasMore: false,
};

/** The first page adds no OFFSET, so the multi-type search reads as before. */
function applySearchOffset<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  window: StudioSearchWindow,
): void {
  if (window.offset > 0) {
    queryBuilder.offset(window.offset);
  }
}

function listenerStats(stats: CatalogReleaseStats): StudioReleaseStats {
  return {
    trackCount: stats.playableTrackCount,
    totalDurationSeconds: stats.playableDurationSeconds,
  };
}

function ownerStats(stats: CatalogReleaseStats): StudioReleaseStats {
  return {
    trackCount: stats.trackCount,
    totalDurationSeconds: stats.totalDurationSeconds,
  };
}

/**
 * What a listener can play, on the card count's aliases: audio and duration
 * in place and (Studio artist kinds) a podcast episode that is published.
 * The track rule of `playableTrackAudioSql`; the release and persona rules
 * are applied by the reads that list the cards.
 */
export const LISTENER_PLAYABLE_TRACK_FILTER_SQL = `"track"."audio_key" IS NOT NULL AND "track"."duration_seconds" IS NOT NULL AND ${episodeReleasedSql('track', 'release')}`;

/**
 * Studio safety: what a listener card's length adds up. A track a copyright
 * claim holds keeps its row (so `playable_track_count` still counts it) and
 * plays nothing, so its length stays out.
 */
export const LISTENER_HEARD_TRACK_FILTER_SQL = `${LISTENER_PLAYABLE_TRACK_FILTER_SQL} AND ${notWithheldTrackSql('track')}`;

/** Track reads one batch runs at once (`runWithConcurrency`). */
const STUDIO_TRACK_BATCH_CONCURRENCY = 4;
/** The single-read answers a batch skips: not found (missing or hidden from
 *  the viewer) and gone (withheld or withdrawn). */
const BATCH_SKIPPED_TRACK_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.NOT_FOUND,
  HttpStatus.GONE,
]);

/**
 * Studio v1: every read. Listeners see published releases of listenable
 * personas whose creator is not blocked either way with them
 * (`listenablePersonaSql` plus `BlockFilterService`); owners also read their
 * own drafts and taken-down releases. Queries use `.limit()` because each
 * join here is many-to-one, so a page is never cut through a row set.
 * Studio v3: a scheduled release is visible (without tracks) to granted
 * listeners on GET /studio/releases/:id and the artist page's Upcoming card,
 * and stays out of every list; a track still uploading stays out of every
 * listener read.
 * Studio artist kinds: a podcast episode reaches listener reads once
 * published (the arm in `LISTENER_PLAYABLE_TRACK_FILTER_SQL`,
 * `isListenerPlayableTrack` and `playableTrackAudioSql`); the feed, search
 * and artists narrow by format.
 * Studio safety and moderation: a withheld track drops out of search and
 * listener card lengths, keeps a redacted row in a listener tracklist, and
 * answers listeners 410 `studio_track_withheld` on its page and stream after
 * every release-level answer; owners read it whole, with their claims.
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
    @InjectRepository(StudioReleaseDispute)
    private readonly disputes: Repository<StudioReleaseDispute>,
    private readonly releaseExtras: StudioReleaseExtrasService,
  ) {}

  async listReleases(
    viewerId: string,
    cursor: string | undefined,
    filters: StudioReleaseFilters = {},
  ): Promise<StudioPage<StudioReleaseCard>> {
    const pageSize = STUDIO_LIMITS.releasesPerPage;
    const queryBuilder = this.withCardColumns(
      this.listenableReleases(viewerId),
    );
    // Genre (v2), mood and scene (discovery), each served by its own
    // partial index in feed order.
    this.applyReleaseFilters(queryBuilder, filters);
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
   * changed is dropped. No counts reach the wire. `covers` carries the
   * browse tile art: the newest such release with a cover, per genre.
   */
  async listGenres(viewerId: string): Promise<StudioGenres> {
    const { values, covers } = await this.presentVocabulary(
      viewerId,
      'genre',
      STUDIO_GENRES,
    );
    return { genres: values, covers };
  }

  /** Studio discovery: the same read for moods, in `STUDIO_MOODS` order. */
  async listMoods(viewerId: string): Promise<StudioMoods> {
    const { values, covers } = await this.presentVocabulary(
      viewerId,
      'mood',
      STUDIO_MOODS,
    );
    return { moods: values, covers };
  }

  /**
   * Studio artist kinds: the formats with at least one release this viewer
   * can hear (blocks apply), in `STUDIO_FORMATS` order. A kind outside the
   * map is dropped. No counts reach the wire.
   */
  async listFormats(viewerId: string): Promise<StudioFormats> {
    const rows = await this.listenableReleases(viewerId)
      .select('DISTINCT "persona"."kind"::text', 'kind')
      .getRawMany<{ kind: string }>();
    const presentFormats = new Set(
      rows.flatMap((row) => {
        const format = studioFormatForKind(row.kind);
        return format ? [format] : [];
      }),
    );
    return {
      formats: STUDIO_FORMATS.filter((format) => presentFormats.has(format)),
    };
  }

  /**
   * The values of one release column that at least one release this viewer
   * can hear carries, in the order of `vocabulary`, with the cover of the
   * newest such release that has one. A stored value outside the vocabulary
   * is dropped. `column` is a literal from this file; the output alias is the
   * column name, so each raw row reads `row[column]`.
   *
   * One query per facet: `DISTINCT ON` keeps one row per value, and the
   * order puts releases with a cover first, then the feed order, so the kept
   * row is the newest covered release, or an uncovered one when the value
   * has no cover at all. The cover URL is the one the release cards serve.
   */
  private async presentVocabulary<Value extends string>(
    viewerId: string,
    column: 'genre' | 'mood',
    vocabulary: readonly Value[],
  ): Promise<{ values: Value[]; covers: Record<string, string> }> {
    const rows = await this.listenableReleases(viewerId)
      .select(
        `DISTINCT ON ("release"."${column}") "release"."${column}"`,
        column,
      )
      .addSelect('"release"."cover_key"', 'cover_key')
      .andWhere(`"release"."${column}" IS NOT NULL`)
      .orderBy(`"release"."${column}"`, 'ASC')
      .addOrderBy('"release"."cover_key" IS NULL', 'ASC')
      .addOrderBy('"release"."published_at"', 'DESC', 'NULLS LAST')
      .addOrderBy('"release"."id"', 'DESC')
      .getRawMany<Record<string, string | null>>();
    const coverKeyByValue = new Map(
      rows.map((row) => [row[column], row.cover_key]),
    );
    const values = vocabulary.filter((value) => coverKeyByValue.has(value));
    const covers: Record<string, string> = {};
    for (const value of values) {
      const coverUrl = toImageUrl(coverKeyByValue.get(value));
      if (coverUrl) {
        covers[value] = coverUrl;
      }
    }
    return { values, covers };
  }

  /** Releases, tracks and artists. Playlists are merged in by the listening
   *  controller (`StudioPlaylistReadsService.searchPlaylists`), so a
   *  `playlists` search answers empty arrays here. */
  async search(
    viewerId: string,
    query: string,
    type: StudioSearchType,
    filters: Pick<StudioReleaseFilters, 'genre' | 'mood' | 'format'> = {},
  ): Promise<StudioSearchResult> {
    const searchPattern = `%${escapeLikeTerm(query.trim())}%`;
    const window = STUDIO_SEARCH_FIRST_WINDOW;
    const [releases, tracks, artists] = await Promise.all([
      type === 'all' || type === 'releases'
        ? this.searchReleases(viewerId, searchPattern, filters, window)
        : Promise.resolve(EMPTY_SEARCH_SLICE),
      type === 'all' || type === 'tracks'
        ? this.searchTracks(viewerId, searchPattern, filters, window)
        : Promise.resolve(EMPTY_SEARCH_SLICE),
      type === 'all' || type === 'artists'
        ? this.searchArtists(viewerId, searchPattern, filters.format, window)
        : Promise.resolve(EMPTY_SEARCH_SLICE),
    ]);
    return {
      releases: releases.items,
      tracks: tracks.items,
      artists: artists.items,
    };
  }

  /** ENG-05: one page of a single-type search, from `offset` (the decoded
   *  cursor). The other two arrays stay empty, and `nextCursor` is null on
   *  the last page. Playlists page in `StudioPlaylistReadsService`. */
  async searchPage(
    viewerId: string,
    query: string,
    type: StudioCatalogSearchType,
    filters: Pick<StudioReleaseFilters, 'genre' | 'mood' | 'format'>,
    offset: number,
  ): Promise<StudioSearchResult & { nextCursor: string | null }> {
    const searchPattern = `%${escapeLikeTerm(query.trim())}%`;
    const window = studioSearchWindowAt(offset);
    const emptyResult: StudioSearchResult = {
      releases: [],
      tracks: [],
      artists: [],
    };
    if (type === 'releases') {
      const slice = await this.searchReleases(
        viewerId,
        searchPattern,
        filters,
        window,
      );
      return {
        ...emptyResult,
        releases: slice.items,
        nextCursor: nextStudioSearchCursor(window, slice.hasMore),
      };
    }
    if (type === 'tracks') {
      const slice = await this.searchTracks(
        viewerId,
        searchPattern,
        filters,
        window,
      );
      return {
        ...emptyResult,
        tracks: slice.items,
        nextCursor: nextStudioSearchCursor(window, slice.hasMore),
      };
    }
    const slice = await this.searchArtists(
      viewerId,
      searchPattern,
      filters.format,
      window,
    );
    return {
      ...emptyResult,
      artists: slice.items,
      nextCursor: nextStudioSearchCursor(window, slice.hasMore),
    };
  }

  /** Studio v3: a scheduled release answers granted listeners too, with no
   *  tracks (the mapper withholds them) and its time. */
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
    if (!isOwner && !(await this.isReleaseVisible(viewerId, release.id))) {
      throw await this.unavailableReleaseError(
        viewerId,
        release,
        'Release not found',
      );
    }
    const [tracks, ownerDisputes, extras] = await Promise.all([
      this.tracks.find({
        where: { releaseId: release.id },
        order: { position: 'ASC' },
      }),
      isOwner
        ? this.ownerDisputesFor(release.id)
        : Promise.resolve<StudioReleaseDispute[]>([]),
      this.releaseExtras.forRelease(viewerId, release),
    ]);
    return toStudioReleaseResponse(
      release,
      release.subprofile,
      tracks,
      { isOwner, isStaff: false },
      ownerDisputes,
      await this.releaseCreditSummary(viewerId, release.id),
      extras,
      // Studio safety: the claim panel, for owners only.
      isOwner
        ? await ownerClaimsForTracks(
            this.tracks.manager,
            tracks.map((track) => track.id),
          )
        : [],
    );
  }

  /**
   * Studio v3: a release read through its private preview link. The token
   * already admitted the caller (`StudioPreviewsService`), so no listenable
   * check runs here. The only refusal is the 404 for a missing release.
   */
  async getReleaseAsPreview(
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
    const [tracks, ownerDisputes, extras] = await Promise.all([
      this.tracks.find({
        where: { releaseId: release.id },
        order: { position: 'ASC' },
      }),
      isOwner
        ? this.ownerDisputesFor(release.id)
        : Promise.resolve<StudioReleaseDispute[]>([]),
      this.releaseExtras.forRelease(viewerId, release),
    ]);
    return toStudioReleaseResponse(
      release,
      release.subprofile,
      tracks,
      { isOwner, isStaff: false, isPreview: true },
      ownerDisputes,
      await this.releaseCreditSummary(viewerId, release.id),
      extras,
    );
  }

  /**
   * The Admin creator drafts detail: the same view a private preview link
   * shows a listener, so the owner-only and staff-only fields read null or
   * empty. An episode preview carries its one draft episode marked
   * `isDraft`, so the frontend can render it apart from the public
   * tracklist.
   */
  async getReleaseAsStaffDraftPreview(
    releaseId: string,
    episodeTrackId: string | null = null,
  ): Promise<StudioReleaseResponse> {
    const release = await this.loadReleaseWithPersona(releaseId);
    if (!release?.subprofile) {
      throw new NotFoundException('Release not found');
    }
    const [tracks, extras] = await Promise.all([
      this.tracks.find({
        where: { releaseId: release.id },
        order: { position: 'ASC' },
      }),
      this.releaseExtras.forRelease(null, release),
    ]);
    const response = toStudioReleaseResponse(
      release,
      release.subprofile,
      tracks,
      { isOwner: false, isStaff: false, isPreview: true },
      [],
      await this.releaseCreditSummary(null, release.id),
      extras,
    );
    if (episodeTrackId === null) {
      return response;
    }
    const draftEpisode = tracks.find((track) => track.id === episodeTrackId);
    if (!draftEpisode || !isDraftEpisode(draftEpisode, release)) {
      throw new NotFoundException('Episode not found');
    }
    const publishedTracks = tracks.filter(
      (track) => (track.publishedAt ?? null) !== null,
    );
    return {
      ...response,
      tracks: [
        ...toListenerTrackSummaries(publishedTracks, release),
        { ...toStudioTrackSummary(draftEpisode), isDraft: true },
      ],
    };
  }

  /** Any release in any status, for the admin routes. */
  async getReleaseForStaff(releaseId: string): Promise<StudioReleaseResponse> {
    const release = await this.loadReleaseWithPersona(releaseId);
    if (!release?.subprofile) {
      throw new NotFoundException('Release not found');
    }
    const [tracks, extras] = await Promise.all([
      this.tracks.find({
        where: { releaseId: release.id },
        order: { position: 'ASC' },
      }),
      this.releaseExtras.forRelease(null, release),
    ]);
    // Staff read the summary with no viewer, so no block applies. The
    // staff view carries no dispute fields, so the disputes stay empty.
    return toStudioReleaseResponse(
      release,
      release.subprofile,
      tracks,
      { isOwner: false, isStaff: true },
      [],
      await this.releaseCreditSummary(null, release.id),
      extras,
    );
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
        coverUrl: true,
        skinData: true,
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
      relations: { scene: true },
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
              StudioReleaseStatus.Scheduled,
              StudioReleaseStatus.TakenDown,
            ]),
          },
          order: { updatedAt: 'DESC' },
          relations: { scene: true },
        })
      : [];
    // Studio v3: the Upcoming card. Read for visitors and owners alike; the
    // filter keeps a scheduled row with its time only.
    const upcomingReleases = (
      await this.releases.find({
        where: { subprofileId, status: StudioReleaseStatus.Scheduled },
        relations: { scene: true },
        order: { publishAt: 'ASC', id: 'ASC' },
        take: STUDIO_LIMITS.upcomingReleasesShown,
      })
    ).filter(
      (release) =>
        release.status === StudioReleaseStatus.Scheduled && release.publishAt,
    );
    const statsByReleaseId = await this.statsFor([
      ...new Set(
        [...publishedReleases, ...ownerOnlyReleases, ...upcomingReleases].map(
          (release) => release.id,
        ),
      ),
    ]);
    const statsOf = (release: StudioRelease): CatalogReleaseStats =>
      statsByReleaseId.get(release.id) ?? EMPTY_CATALOG_STATS;
    // Keyed by the stored id: a link may carry the id in any letter case.
    const [followerCounts, followedPersonaIds, supportLinks, remindedIds] =
      await Promise.all([
        this.followers.loadFollowerCountsFor([persona.id]),
        this.followers.viewerFollowingFor(viewerId, [persona.id]),
        this.releaseExtras.supportLinksFor(persona.id),
        this.releaseExtras.reminderStatesFor(
          viewerId,
          upcomingReleases.map((release) => release.id),
        ),
      ]);
    const upcoming: StudioUpcomingRelease[] = upcomingReleases.flatMap(
      (release) =>
        release.publishAt
          ? [
              {
                ...toStudioReleaseCard(
                  release,
                  persona,
                  listenerStats(statsOf(release)),
                ),
                publishAt: release.publishAt.toISOString(),
                isReminderSet: remindedIds.has(release.id),
              },
            ]
          : [],
    );
    return {
      artist: {
        ...toStudioFormatArtistRef(persona),
        bio: persona.bio,
        city: null,
        ...toStudioArtistHeroFields(persona),
      },
      releases: publishedReleases.map((release) =>
        toStudioReleaseCard(release, persona, listenerStats(statsOf(release))),
      ),
      ownerReleases: isOwner
        ? ownerOnlyReleases.map((release) =>
            toStudioOwnerReleaseCard(
              release,
              persona,
              ownerStats(statsOf(release)),
            ),
          )
        : null,
      followerCount: followerCounts.get(persona.id) ?? 0,
      isFollowing: followedPersonaIds.has(persona.id),
      supportLinks,
      upcoming,
    };
  }

  /**
   * A batch of `getTrack` for the Continue listening shelf. Every id runs
   * the single read, so the guards, the owner view and every listener rule
   * match it exactly. A track the single read answers 404 or 410 for
   * (missing, hidden from the viewer, withheld, withdrawn) drops out
   * quietly; any other failure fails the batch. Request order, a few reads
   * at a time so one batch never holds the pool.
   */
  async getTracks(
    viewerId: string,
    trackIds: readonly string[],
  ): Promise<{ items: StudioTrackResponse[] }> {
    const tracks = await runWithConcurrency(
      trackIds.map((trackId) => () => this.getTrackOrNull(viewerId, trackId)),
      STUDIO_TRACK_BATCH_CONCURRENCY,
    );
    return {
      items: tracks.filter(
        (track): track is StudioTrackResponse => track !== null,
      ),
    };
  }

  private async getTrackOrNull(
    viewerId: string,
    trackId: string,
  ): Promise<StudioTrackResponse | null> {
    try {
      return await this.getTrack(viewerId, trackId);
    } catch (error) {
      if (
        error instanceof HttpException &&
        BATCH_SKIPPED_TRACK_STATUSES.has(error.getStatus())
      ) {
        return null;
      }
      throw error;
    }
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
    // Studio v3: a track still uploading on a live release is the owner's.
    // Studio artist kinds: so is an episode not published yet.
    if (!isOwner && !isListenerPlayableTrack(track, release)) {
      throw new NotFoundException('Track not found');
    }
    if (!isOwner && !(await this.isReleaseListenable(viewerId, release.id))) {
      throw await this.unavailableReleaseError(
        viewerId,
        release,
        'Track not found',
      );
    }
    // Studio safety: after every release-level answer, a withheld track is
    // a 410 for listeners that names nothing. Owners still read it, with
    // its claims.
    if (!isOwner && isWithheldTrack(track)) {
      throw studioSafetyError('studio_track_withheld');
    }
    const stats =
      (await this.statsFor([release.id])).get(release.id) ??
      EMPTY_CATALOG_STATS;
    return toStudioTrackResponse(
      track,
      {
        ...toStudioReleaseCard(
          release,
          release.subprofile,
          listenerStats(stats),
        ),
        status: release.status,
      },
      await this.trackPublicCredits(viewerId, track.id),
      { isOwner },
      isOwner
        ? await ownerClaimsForTracks(this.tracks.manager, [track.id])
        : [],
    );
  }

  /**
   * A stream URL that lives for the track's length plus ten minutes (15
   * minutes to six hours), with the measurements the upload stored. Listeners
   * stream published, listenable releases;
   * owners also stream their drafts and scheduled releases; nobody streams a
   * taken-down release.
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
    // Studio artist kinds: an owner streams a draft episode; a listener
    // streams published episodes only.
    const isStreamable = isOwner
      ? hasPlayableAudio(track)
      : isListenerPlayableTrack(track, release);
    if (
      !isAllowed ||
      !isStreamable ||
      !track.audioKey ||
      !track.audioContentType
    ) {
      throw new NotFoundException('Track not found');
    }
    // Studio safety: owners stream a withheld track, so they can hear what
    // was claimed; listeners get the 410 that names nothing.
    if (!isOwner && isWithheldTrack(track)) {
      throw studioSafetyError('studio_track_withheld');
    }
    const signedStream = await this.storage.createPresignedAudioStream(
      track.audioKey,
      track.audioContentType,
      track.durationSeconds,
    );
    return toStudioStream(
      signedStream,
      track,
      await findGaplessAfterTrackId(this.tracks, release, track),
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

  /** Studio v3: a release a granted listener may open: published, or
   *  scheduled (shown without tracks), on a listenable persona whose
   *  creator is not blocked either way. */
  private isReleaseVisible(
    viewerId: string,
    releaseId: string,
  ): Promise<boolean> {
    const queryBuilder = this.releases
      .createQueryBuilder('release')
      .innerJoin('release.subprofile', 'persona')
      .where('release.status IN (:...visibleStatuses)', {
        visibleStatuses: [
          StudioReleaseStatus.Published,
          StudioReleaseStatus.Scheduled,
        ],
      })
      .andWhere(listenablePersonaSql('persona'))
      .andWhere('release.id = :releaseId', { releaseId });
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    return queryBuilder.getExists();
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

  /**
   * Studio open demo pages: why a release a non-owner cannot hear is
   * unavailable. A release staff took down while it was live, of a persona
   * this viewer can still hear (listenable, no block either way), answers
   * 410 `studio_release_withdrawn` with nothing about the release in the
   * body. Every other cause (draft, a taken-down draft, persona unlisted,
   * private or taken down, a block) keeps the plain 404, so the 410 tells a
   * listener nothing they could not already see.
   */
  private async unavailableReleaseError(
    viewerId: string,
    release: StudioRelease,
    notFoundMessage: string,
  ): Promise<HttpException> {
    if (
      isReleaseWithdrawnForListeners(release) &&
      (await this.isPersonaListenable(viewerId, release.subprofileId))
    ) {
      return studioError('studio_release_withdrawn');
    }
    return new NotFoundException(notFoundMessage);
  }

  /** Newest first; a release never holds more than
   *  `STUDIO_LIMITS.disputesPerRelease`, so the cap reads them all. */
  private ownerDisputesFor(releaseId: string): Promise<StudioReleaseDispute[]> {
    return this.disputes.find({
      where: { releaseId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: STUDIO_LIMITS.disputesPerRelease,
    });
  }

  private loadReleaseWithPersona(
    releaseId: string,
  ): Promise<StudioRelease | null> {
    return this.withCardColumns(
      this.releases
        .createQueryBuilder('release')
        .innerJoin('release.subprofile', 'persona'),
    )
      .where('release.id = :releaseId', { releaseId })
      .getOne();
  }

  private async searchReleases(
    viewerId: string,
    searchPattern: string,
    filters: Pick<StudioReleaseFilters, 'genre' | 'mood' | 'format'>,
    window: StudioSearchWindow,
  ): Promise<StudioSearchSlice<StudioReleaseCard>> {
    const queryBuilder = this.withCardColumns(
      this.listenableReleases(viewerId),
    ).andWhere(
      `(${foldedHaystack('release', ['title'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\'
          OR ${foldedHaystack('persona', ['display_name'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\')`,
      { studioSearchPattern: searchPattern },
    );
    this.applyReleaseFilters(queryBuilder, filters);
    queryBuilder
      .orderBy('release.publishedAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .limit(studioSearchRowLimit(window));
    applySearchOffset(queryBuilder, window);
    const { pageRows, hasMore } = sliceStudioSearchRows(
      await queryBuilder.getMany(),
      window,
    );
    return { items: await this.toCards(pageRows), hasMore };
  }

  private async searchTracks(
    viewerId: string,
    searchPattern: string,
    filters: Pick<StudioReleaseFilters, 'genre' | 'mood' | 'format'>,
    window: StudioSearchWindow,
  ): Promise<StudioSearchSlice<StudioSearchResult['tracks'][number]>> {
    const queryBuilder = this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .innerJoin('release.subprofile', 'persona')
      .where('release.status = :publishedStatus', {
        publishedStatus: StudioReleaseStatus.Published,
      })
      .andWhere(listenablePersonaSql('persona'))
      // Studio v3: a track still uploading on a live release stays hidden.
      .andWhere('"track"."audio_key" IS NOT NULL')
      .andWhere('"track"."duration_seconds" IS NOT NULL')
      // Studio artist kinds: a draft episode stays hidden.
      .andWhere(episodeReleasedSql('track', 'release'))
      // Studio safety: so does a track a copyright claim holds offline.
      .andWhere(notWithheldTrackSql('track'))
      .andWhere(
        `${foldedHaystack('track', ['title'])} LIKE ${foldedSearchTerm('studioSearchPattern')} ESCAPE '\\'`,
        { studioSearchPattern: searchPattern },
      )
      .orderBy('release.publishedAt', 'DESC')
      .addOrderBy('release.id', 'DESC')
      .addOrderBy('track.position', 'ASC')
      .limit(studioSearchRowLimit(window));
    applySearchOffset(queryBuilder, window);
    this.applyReleaseFilters(queryBuilder, filters);
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    // The probe row comes off before the cards are read, so a track whose
    // card is missing never hides that more rows exist.
    const { pageRows: matchedTracks, hasMore } = sliceStudioSearchRows(
      await queryBuilder.getMany(),
      window,
    );
    const cardsByReleaseId = await this.cardsByReleaseId([
      ...new Set(matchedTracks.map((track) => track.releaseId)),
    ]);
    const items = matchedTracks.flatMap((track) => {
      const releaseCard = cardsByReleaseId.get(track.releaseId);
      return releaseCard
        ? [{ ...toStudioTrackSummary(track), release: releaseCard }]
        : [];
    });
    return { items, hasMore };
  }

  private async searchArtists(
    viewerId: string,
    searchPattern: string,
    format: StudioFormat | undefined,
    window: StudioSearchWindow,
  ): Promise<StudioSearchSlice<StudioSearchResult['artists'][number]>> {
    const queryBuilder = this.subprofiles
      .createQueryBuilder('persona')
      .select(ARTIST_PERSONA_COLUMNS)
      .where('persona.kind IN (:...artistKinds)', {
        // Studio artist kinds: one format's kinds when the search names one.
        artistKinds: format
          ? studioPersonaKindsForFormat(format)
          : [...STUDIO_ARTIST_PERSONA_KINDS],
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
      // ENG-05: the id breaks display-name ties, so an offset page is stable.
      .addOrderBy('persona.id', 'ASC')
      .limit(studioSearchRowLimit(window));
    applySearchOffset(queryBuilder, window);
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"persona"."user_id"',
    );
    const { pageRows, hasMore } = sliceStudioSearchRows(
      await queryBuilder.getMany(),
      window,
    );
    return { items: pageRows.map(toStudioFormatArtistRef), hasMore };
  }

  /** Cards for releases already known to be readable by the caller. Public
   *  for the playlist reads (Studio v2), which check playability first. */
  async cardsByReleaseId(
    releaseIds: string[],
  ): Promise<Map<string, StudioReleaseCard>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows = await this.withCardColumns(
      this.releases
        .createQueryBuilder('release')
        .innerJoin('release.subprofile', 'persona'),
    )
      .where('release.id IN (:...releaseIds)', { releaseIds })
      .getMany();
    const cards = await this.toCards(rows);
    return new Map(cards.map((card) => [card.id, card]));
  }

  /** Studio open demo pages: staff summaries for the flag-review lists, in
   *  any status and with no listener gate (the routes are staff only). One
   *  release read plus one stats read. */
  async staffSummariesByReleaseId(
    releaseIds: string[],
  ): Promise<Map<string, StudioAdminReleaseSummary>> {
    if (!releaseIds.length) {
      return new Map();
    }
    // The card columns, so a summary carries its scene like every card.
    const rows = await this.withCardColumns(
      this.releases
        .createQueryBuilder('release')
        .innerJoin('release.subprofile', 'persona'),
    )
      .where('release.id IN (:...releaseIds)', { releaseIds })
      .getMany();
    const statsByReleaseId = await this.statsFor(rows.map((row) => row.id));
    return new Map(
      rows.flatMap((row): [string, StudioAdminReleaseSummary][] =>
        row.subprofile
          ? [
              [
                row.id,
                toStudioAdminReleaseSummary(
                  row,
                  row.subprofile,
                  statsByReleaseId.get(row.id) ?? EMPTY_RELEASE_STATS,
                ),
              ],
            ]
          : [],
      ),
    );
  }

  /** Studio discovery: accepted credits to public personas on one track. */
  private async trackPublicCredits(
    viewerId: string,
    trackId: string,
  ): Promise<StudioPersonaCreditPublic[]> {
    const rows: PublicCreditRow[] = await this.tracks.query(
      TRACK_PUBLIC_CREDITS_SQL,
      [viewerId, trackId],
    );
    return toPublicTrackCredits(rows);
  }

  /** Studio discovery: the album page "Credits" summary. A null viewer is
   *  the staff view. */
  private async releaseCreditSummary(
    viewerId: string | null,
    releaseId: string,
  ): Promise<StudioReleaseCreditSummary[]> {
    const rows: PublicCreditRow[] = await this.tracks.query(
      RELEASE_CREDIT_SUMMARY_SQL,
      [viewerId, releaseId],
    );
    return toReleaseCreditSummary(rows);
  }

  /** The persona and scene columns every release card reads. */
  private withCardColumns<Builder extends SelectQueryBuilder<StudioRelease>>(
    queryBuilder: Builder,
  ): Builder {
    queryBuilder
      .addSelect(ARTIST_PERSONA_COLUMNS)
      .leftJoin('release.scene', 'scene')
      .addSelect(CARD_SCENE_COLUMNS);
    return queryBuilder;
  }

  // Generic over the builder's entity: the release feed and the track
  // search both alias the release as `release` and its persona as `persona`.
  private applyReleaseFilters<Entity extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<Entity>,
    filters: StudioReleaseFilters,
  ): void {
    if (filters.genre) {
      queryBuilder.andWhere('"release"."genre" = :studioGenre', {
        studioGenre: filters.genre,
      });
    }
    if (filters.mood) {
      queryBuilder.andWhere('"release"."mood" = :studioMood', {
        studioMood: filters.mood,
      });
    }
    if (filters.sceneId) {
      queryBuilder.andWhere('"release"."scene_id" = :studioSceneId', {
        studioSceneId: filters.sceneId,
      });
    }
    if (filters.format) {
      queryBuilder.andWhere('"persona"."kind" IN (:...studioFormatKinds)', {
        studioFormatKinds: studioPersonaKindsForFormat(filters.format),
      });
    }
  }

  private async toCards(rows: StudioRelease[]): Promise<StudioReleaseCard[]> {
    const statsByReleaseId = await this.statsFor(rows.map((row) => row.id));
    return rows.flatMap((row) =>
      row.subprofile
        ? [
            toStudioReleaseCard(
              row,
              row.subprofile,
              listenerStats(
                statsByReleaseId.get(row.id) ?? EMPTY_CATALOG_STATS,
              ),
            ),
          ]
        : [],
    );
  }

  // One grouped query for a whole page of releases.
  private async statsFor(
    releaseIds: string[],
  ): Promise<Map<string, CatalogReleaseStats>> {
    if (!releaseIds.length) {
      return new Map();
    }
    const rows = await this.tracks
      .createQueryBuilder('track')
      .innerJoin('track.release', 'release')
      .select('"track"."release_id"', 'release_id')
      .addSelect('COUNT(*)::int', 'track_count')
      .addSelect(
        `COUNT(*) FILTER (WHERE ${LISTENER_PLAYABLE_TRACK_FILTER_SQL})::int`,
        'playable_track_count',
      )
      .addSelect(
        'COALESCE(SUM("track"."duration_seconds") FILTER (WHERE "track"."audio_key" IS NOT NULL), 0)::int',
        'total_duration_seconds',
      )
      .addSelect(
        `COALESCE(SUM("track"."duration_seconds") FILTER (WHERE ${LISTENER_HEARD_TRACK_FILTER_SQL}), 0)::int`,
        'playable_duration_seconds',
      )
      .where('"track"."release_id" IN (:...releaseIds)', { releaseIds })
      .groupBy('"track"."release_id"')
      .getRawMany<ReleaseStatsRow>();
    return new Map(
      rows.map((row) => [
        row.release_id,
        {
          trackCount: Number(row.track_count),
          playableTrackCount: Number(row.playable_track_count),
          playableDurationSeconds: Number(row.playable_duration_seconds),
          totalDurationSeconds: Number(row.total_duration_seconds),
        },
      ]),
    );
  }
}
