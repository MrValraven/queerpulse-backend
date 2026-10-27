import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { UpdateStudioPlaybackDto } from '../preferences/dto/update-studio-playback.dto';
import { StudioPlaybackDTO } from '../preferences/preferences-response';
import { PreferencesService } from '../preferences/preferences.service';
import { StudioAccessGuard } from './studio-access.guard';

/**
 * Studio open demo pages (section 6.1): `GET|PUT /me/studio-playback`, the
 * Studio player's three settings, stored on `member_preferences` by
 * `PreferencesService` like every other `/me/<group>` pair.
 *
 * Served from `StudioModule` because the Studio grant guard lives here:
 * `StudioModule` imports `PreferencesModule`, so serving this route from
 * `PreferencesModule` would need the reverse import to reach
 * `StudioAccessGuard` and would close an import cycle. The routes store
 * the player settings, the listening history switch and the first-play notice date.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('me')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaybackPreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('studio-playback')
  @ApiOperation({ summary: "The caller's Studio player settings." })
  @ApiOkResponse({
    description: '`StudioPlayback` (defaults when never saved).',
  })
  getStudioPlayback(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioPlaybackDTO> {
    return this.preferences.getStudioPlayback(user.userId);
  }

  @Put('studio-playback')
  @ApiOperation({
    summary: "Change one or more of the caller's Studio player settings.",
  })
  @ApiOkResponse({ description: 'The stored `StudioPlayback`.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  updateStudioPlayback(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateStudioPlaybackDto,
  ): Promise<StudioPlaybackDTO> {
    return this.preferences.updateStudioPlayback(user.userId, body);
  }
}
