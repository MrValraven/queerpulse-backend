import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ListStudioReleasesQuery } from './dto/list-studio-releases.query';
import { ListStudioTracksQuery } from './dto/list-studio-tracks.query';
import { SearchStudioQuery } from './dto/search-studio.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioArtistWithPlaylists,
  StudioPlaylistCard,
  StudioSearchResultWithPlaylists,
} from './studio-playlist-response';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { decodeStudioSearchCursor } from './studio-search-cursor';
import { StudioSearchType } from './studio.constants';
import {
  StudioFormats,
  StudioGenres,
  StudioMoods,
  StudioPage,
  StudioReleaseCard,
  StudioReleaseResponse,
  StudioStream,
  StudioTrackResponse,
} from './studio-response';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioListeningController {
  constructor(
    private readonly catalog: StudioCatalogService,
    private readonly playlistReads: StudioPlaylistReadsService,
  ) {}

  @Get('releases')
  @ApiOperation({
    summary: 'Published releases, newest first, by genre, mood and format.',
  })
  @ApiOkResponse({ description: '`StudioPage<StudioReleaseCard>`.' })
  listReleases(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListStudioReleasesQuery,
  ): Promise<StudioPage<StudioReleaseCard>> {
    return this.catalog.listReleases(user.userId, query.cursor, {
      genre: query.genre,
      mood: query.mood,
      format: query.format,
    });
  }

  @Get('genres')
  @ApiOperation({ summary: 'Genres with a release the caller can hear.' })
  @ApiOkResponse({ description: '`StudioGenres`.' })
  listGenres(@CurrentUser() user: CurrentUserData): Promise<StudioGenres> {
    return this.catalog.listGenres(user.userId);
  }

  @Get('moods')
  @ApiOperation({ summary: 'Moods with a release the caller can hear.' })
  @ApiOkResponse({ description: '`StudioMoods`.' })
  listMoods(@CurrentUser() user: CurrentUserData): Promise<StudioMoods> {
    return this.catalog.listMoods(user.userId);
  }

  // Studio artist kinds. Skipped by the request log, the HTTP metrics and
  // Sentry (`isStudioListeningRequest`).
  @Get('formats')
  @ApiOperation({ summary: 'Formats with a release the caller can hear.' })
  @ApiOkResponse({ description: '`StudioFormats`.' })
  listFormats(@CurrentUser() user: CurrentUserData): Promise<StudioFormats> {
    return this.catalog.listFormats(user.userId);
  }

  // Playlists are merged here so the catalog never depends on the playlist
  // reads, which depend on it. ENG-05: a single type pages by `cursor` and
  // answers `nextCursor`; the multi-type search keeps its 20 per type.
  @Get('search')
  @ApiOperation({ summary: 'Search releases, tracks, artists and playlists.' })
  @ApiOkResponse({
    description:
      '`StudioSearchResult`, plus `nextCursor` when `type` names one type.',
  })
  async search(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SearchStudioQuery,
  ): Promise<StudioSearchResultWithPlaylists> {
    const type = query.type ?? 'all';
    if (type !== 'all') {
      return this.searchOneType(user.userId, query, type);
    }
    const [catalogResult, playlists] = await Promise.all([
      this.catalog.search(user.userId, query.q, type, {
        genre: query.genre,
        mood: query.mood,
        format: query.format,
      }),
      type === 'all' || type === 'playlists'
        ? this.playlistReads.searchPlaylists(user.userId, query.q)
        : Promise.resolve<StudioPlaylistCard[]>([]),
    ]);
    return { ...catalogResult, playlists };
  }

  private async searchOneType(
    viewerId: string,
    query: SearchStudioQuery,
    type: Exclude<StudioSearchType, 'all'>,
  ): Promise<StudioSearchResultWithPlaylists> {
    const offset = decodeStudioSearchCursor(query.cursor);
    if (type === 'playlists') {
      const playlistPage = await this.playlistReads.searchPlaylistsPage(
        viewerId,
        query.q,
        offset,
      );
      return {
        releases: [],
        tracks: [],
        artists: [],
        playlists: playlistPage.items,
        nextCursor: playlistPage.nextCursor,
      };
    }
    const catalogPage = await this.catalog.searchPage(
      viewerId,
      query.q,
      type,
      { genre: query.genre, mood: query.mood, format: query.format },
      offset,
    );
    return { ...catalogPage, playlists: [] };
  }

  @Get('releases/:id')
  @ApiOperation({ summary: 'One release with its tracks.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  getRelease(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.catalog.getRelease(user.userId, releaseId);
  }

  @Get('artists/:subprofileId')
  @ApiOperation({ summary: "A persona's Studio page." })
  @ApiOkResponse({ description: '`StudioArtist`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  async getArtist(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioArtistWithPlaylists> {
    // The artist read answers 404 first, so playlists are only read for a
    // persona the caller can see.
    const artist = await this.catalog.getArtist(user.userId, subprofileId);
    const playlists = await this.playlistReads.listForArtistView(
      user.userId,
      subprofileId,
    );
    return { ...artist, playlists };
  }

  @Get('tracks')
  @ApiOperation({
    summary:
      'Up to 20 tracks by id, each read as GET /studio/tracks/:id reads it.',
    description:
      'A track that read would answer 404 or 410 for is left out; the rest come back in request order. Nothing about the request is recorded.',
  })
  @ApiOkResponse({ description: '`{ items: StudioTrack[] }`.' })
  getTracks(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListStudioTracksQuery,
  ): Promise<{ items: StudioTrackResponse[] }> {
    return this.catalog.getTracks(user.userId, query.ids);
  }

  @Get('tracks/:id')
  @ApiOperation({ summary: 'One track with credits and lyrics.' })
  @ApiOkResponse({ description: '`StudioTrack`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  getTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<StudioTrackResponse> {
    return this.catalog.getTrack(user.userId, trackId);
  }

  // The body is a short-lived signed URL, so it is never cached.
  @Get('tracks/:id/stream')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      "A signed URL for one track, valid for its length plus ten minutes, with the upload's waveform and loudness.",
  })
  @ApiOkResponse({ description: '`StudioStream`.' })
  @ApiNotFoundResponse({
    description: 'Missing, hidden from you, taken down, or still uploading.',
  })
  getStream(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<StudioStream> {
    return this.catalog.getStream(user.userId, trackId);
  }
}
