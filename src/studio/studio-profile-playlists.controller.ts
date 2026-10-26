import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { UpdateStudioProfilePlaylistsDto } from './dto/update-studio-profile-playlists.dto';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioProfilePlaylists,
  StudioProfilePlaylistsService,
} from './studio-profile-playlists.service';

// Two segments under `studio/me`, so no `:id` route above it can match.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/me/profile-playlists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioProfilePlaylistsController {
  constructor(
    private readonly profilePlaylists: StudioProfilePlaylistsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Whether your playlists show on your profile, and which lead it.',
  })
  @ApiOkResponse({
    description: '`{ isShown, featuredIds, items: StudioPlaylistCard[] }`.',
  })
  get(@CurrentUser() user: CurrentUserData): Promise<StudioProfilePlaylists> {
    return this.profilePlaylists.get(user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Save the profile playlist setting.' })
  @ApiOkResponse({ description: 'The stored setting, as on GET.' })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_profile_playlist_not_yours`.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateStudioProfilePlaylistsDto,
  ): Promise<StudioProfilePlaylists> {
    return this.profilePlaylists.update(user.userId, dto);
  }
}
