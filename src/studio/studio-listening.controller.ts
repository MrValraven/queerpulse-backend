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
import { SearchStudioQuery } from './dto/search-studio.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioArtistResponse,
  StudioPage,
  StudioReleaseCard,
  StudioReleaseResponse,
  StudioSearchResult,
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
  constructor(private readonly catalog: StudioCatalogService) {}

  @Get('releases')
  @ApiOperation({ summary: 'Published releases, newest first.' })
  @ApiOkResponse({ description: '`StudioPage<StudioReleaseCard>`.' })
  listReleases(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListStudioReleasesQuery,
  ): Promise<StudioPage<StudioReleaseCard>> {
    return this.catalog.listReleases(user.userId, query.cursor);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search releases, tracks and artists.' })
  @ApiOkResponse({ description: '`StudioSearchResult`.' })
  search(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SearchStudioQuery,
  ): Promise<StudioSearchResult> {
    return this.catalog.search(user.userId, query.q, query.type ?? 'all');
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
  getArtist(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioArtistResponse> {
    return this.catalog.getArtist(user.userId, subprofileId);
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
  @ApiOperation({ summary: 'A 15-minute signed URL for one track.' })
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
