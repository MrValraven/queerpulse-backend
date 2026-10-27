import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { RecordStudioPlayDto } from './dto/record-studio-play.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPlaysService } from './studio-plays.service';

/**
 * Always answers 204 with an empty body after validation: nothing in the
 * answer says whether the play counted. The limiter lives in the service
 * (`StudioPlayGate`), so the route carries no `@Throttle`, and the request
 * body never reaches a log.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaysController {
  constructor(private readonly plays: StudioPlaysService) {}

  @Post('plays')
  @HttpCode(204)
  @ApiOperation({ summary: 'Reports that the caller played a track.' })
  @ApiNoContentResponse({
    description: 'Always, whatever the server did with the play.',
  })
  async recordPlay(
    @CurrentUser() user: CurrentUserData,
    @Body() body: RecordStudioPlayDto,
  ): Promise<void> {
    await this.plays.recordPlay(user.userId, body.trackId);
  }
}
