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
import { UpdateStudioWelcomeDto } from '../preferences/dto/update-studio-welcome.dto';
import { StudioWelcomeDTO } from '../preferences/preferences-response';
import { PreferencesService } from '../preferences/preferences.service';
import { StudioAccessGuard } from './studio-access.guard';

/**
 * Studio welcome, once per account: `GET|PUT /me/studio-welcome`. The seen
 * stamp and the taste picks (genres and moods) are stored on
 * `member_preferences` by `PreferencesService`, so a member who finished the
 * welcome on a phone does not see it again on a computer.
 *
 * Served from `StudioModule` for the same reason as
 * `StudioPlaybackPreferencesController`: the Studio grant guard lives here
 * and serving the route from `PreferencesModule` would close an import cycle.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('me')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioWelcomeController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('studio-welcome')
  @ApiOperation({ summary: "The caller's Studio welcome state and taste." })
  @ApiOkResponse({
    description: '`StudioWelcome` (defaults when never saved).',
  })
  getStudioWelcome(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioWelcomeDTO> {
    return this.preferences.getStudioWelcome(user.userId);
  }

  @Put('studio-welcome')
  @ApiOperation({
    summary: "Save the caller's Studio welcome state and taste picks.",
  })
  @ApiOkResponse({ description: 'The stored `StudioWelcome`.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  updateStudioWelcome(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateStudioWelcomeDto,
  ): Promise<StudioWelcomeDTO> {
    return this.preferences.updateStudioWelcome(user.userId, body);
  }
}
