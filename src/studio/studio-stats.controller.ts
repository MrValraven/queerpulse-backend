import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { StudioArtistStats } from './studio-stats';
import { StudioStatsService } from './studio-stats.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioStatsController {
  constructor(private readonly stats: StudioStatsService) {}

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
}
