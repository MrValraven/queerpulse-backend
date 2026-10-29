import { Controller, Get, UseGuards } from '@nestjs/common';
import {
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
import { StudioAccessGuard } from './studio-access.guard';
import { StudioFoundingArtistsService } from './studio-founding-artists.service';
import { StudioFoundingArtists } from './studio-landing-response';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/founding-artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioFoundingArtistsController {
  constructor(private readonly foundingArtists: StudioFoundingArtistsService) {}

  @Get()
  @ApiOperation({
    summary: 'The founding artists, for the badge on cards and pages.',
  })
  @ApiOkResponse({ description: '`StudioFoundingArtists`.' })
  getFoundingArtists(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioFoundingArtists> {
    return this.foundingArtists.getFoundingArtists(user.userId);
  }
}
