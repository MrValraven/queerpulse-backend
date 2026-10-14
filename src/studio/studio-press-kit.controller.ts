import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { UpdateStudioPressKitDto } from './dto/update-studio-press-kit.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPressKitResponse } from './studio-press-kit-response';
import { StudioPressKitService } from './studio-press-kit.service';

// Studio v3 press kit. Granted members only, like the rest of Studio; the
// one-sheet is what artists hand to people outside QueerPulse. The request
// log, metrics and Sentry skip this route (`studio-request-log.ts`).
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    '`studio_access_required`, `studio_not_persona_owner` or `studio_persona_kind_not_allowed`.',
})
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPressKitController {
  constructor(private readonly pressKits: StudioPressKitService) {}

  @Get(':subprofileId/press-kit')
  @ApiOperation({ summary: "A Studio artist persona's press kit." })
  @ApiOkResponse({ description: '`StudioPressKit`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  getPressKit(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioPressKitResponse> {
    return this.pressKits.getPressKit(user.userId, subprofileId);
  }

  @Put(':subprofileId/press-kit')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Save the press kit (owners and co-owners).' })
  @ApiOkResponse({ description: '`StudioPressKit`.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_press_track_not_allowed`.',
  })
  updatePressKit(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Body() body: UpdateStudioPressKitDto,
  ): Promise<StudioPressKitResponse> {
    return this.pressKits.updatePressKit(user.userId, subprofileId, body);
  }
}
