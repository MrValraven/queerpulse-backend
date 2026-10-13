import {
  Controller,
  Get,
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
import { ListStudioPlaylistsQuery } from './dto/list-studio-playlists.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  StudioPlaylistCard,
  StudioPlaylistList,
} from './studio-playlist-response';
import { StudioPage } from './studio-response';

// Playlist lists on the pages of something else: a persona, a member, a
// track. `/studio/tracks/:id/playlists` is kept out of the request log and
// metrics with every other track path.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaylistListingsController {
  constructor(private readonly playlistReads: StudioPlaylistReadsService) {}

  @Get('artists/:subprofileId/playlists')
  @ApiOperation({ summary: 'Public playlists credited to a persona.' })
  @ApiOkResponse({ description: '`StudioPage<StudioPlaylistCard>`.' })
  listForArtist(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Query() query: ListStudioPlaylistsQuery,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    return this.playlistReads.listCreditedToPersona(
      user.userId,
      subprofileId,
      query.cursor,
    );
  }

  // Addressed by profile slug, the only member key the profile page holds.
  // The slug only ever reaches a bound query parameter; an unknown one
  // answers an empty page.
  @Get('members/:slug/playlists')
  @ApiOperation({ summary: 'Playlists credited to a member.' })
  @ApiOkResponse({ description: '`StudioPage<StudioPlaylistCard>`.' })
  listForMember(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') memberSlug: string,
    @Query() query: ListStudioPlaylistsQuery,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    return this.playlistReads.listCreditedToMember(
      user.userId,
      memberSlug,
      query.cursor,
    );
  }

  @Get('tracks/:id/playlists')
  @ApiOperation({ summary: 'Up to six public playlists holding a track.' })
  @ApiOkResponse({ description: '`{ items: StudioPlaylistCard[] }`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  listForTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<StudioPlaylistList> {
    return this.playlistReads.listForTrack(user.userId, trackId);
  }
}
