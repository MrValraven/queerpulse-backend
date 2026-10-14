import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
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
import { StudioRadioQuery } from './dto/studio-radio.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioRadio, StudioRadioService } from './studio-radio.service';

// `/studio/radio` is kept out of the request log, the HTTP metrics and
// Sentry by `isStudioListeningRequest`, with any query string.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioRadioController {
  constructor(private readonly radio: StudioRadioService) {}

  @Get('radio')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Up to 300 playable tracks of a genre or a mood.' })
  @ApiOkResponse({ description: '`StudioRadio`.' })
  @ApiBadRequestResponse({ description: '`studio_radio_filter_required`.' })
  getRadio(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StudioRadioQuery,
  ): Promise<StudioRadio> {
    return this.radio.getRadio(user.userId, query);
  }
}
