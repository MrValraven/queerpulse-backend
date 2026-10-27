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
import { StudioAccessGuard } from './studio-access.guard';
import { StudioArtistPlaysQuery } from './dto/studio-artist-plays.query';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioArtistMilestonesService } from './studio-artist-milestones.service';
import { StudioArtistPlacementsService } from './studio-artist-placements.service';
import { StudioArtistPlaysService } from './studio-artist-plays.service';
import { StudioMilestonesResponse } from './studio-milestones';
import { StudioPlacementsPage } from './studio-placements';
import { StudioArtistPlays, StudioArtistStats } from './studio-stats';
import { StudioStatsService } from './studio-stats.service';
import { StudioTopSupporters } from './studio-supporters';
import { StudioSupportersService } from './studio-supporters.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioStatsController {
  constructor(
    private readonly stats: StudioStatsService,
    private readonly placements: StudioArtistPlacementsService,
    private readonly milestones: StudioArtistMilestonesService,
    private readonly artistPlays: StudioArtistPlaysService,
    private readonly supporters: StudioSupportersService,
  ) {}

  @Get(':subprofileId/stats')
  @ApiOperation({ summary: "A persona's current totals, for its owners." })
  @ApiOkResponse({ description: '`StudioArtistStats`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  getStats(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioArtistStats> {
    return this.stats.getArtistStats(user.userId, subprofileId);
  }

  @Get(':subprofileId/placements')
  @ApiOperation({
    summary: 'The playlists that carry the persona tracks, newest first.',
  })
  @ApiOkResponse({ description: '`StudioPlacementsPage`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  listPlacements(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPlacementsPage> {
    return this.placements.listPlacements(
      user.userId,
      subprofileId,
      query.cursor,
    );
  }

  @Get(':subprofileId/milestones')
  @ApiOperation({ summary: "A persona's reached milestones, newest first." })
  @ApiOkResponse({ description: '`StudioMilestonesResponse`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  listMilestones(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioMilestonesResponse> {
    return this.milestones.listMilestones(user.userId, subprofileId);
  }

  @Get(':subprofileId/plays')
  @ApiOperation({ summary: "A persona's daily plays over 28 days." })
  @ApiOkResponse({ description: '`StudioArtistPlays`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  getPlays(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    // Validation alone: the 28-day window is the only one served.
    @Query() _query: StudioArtistPlaysQuery,
  ): Promise<StudioArtistPlays> {
    return this.artistPlays.getArtistPlays(user.userId, subprofileId);
  }

  @Get(':subprofileId/supporters')
  @ApiOperation({ summary: "A persona's top supporters, for its owners." })
  @ApiOkResponse({ description: '`StudioTopSupporters`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  listTopSupporters(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioTopSupporters> {
    return this.supporters.listTopSupporters(user.userId, subprofileId);
  }
}
