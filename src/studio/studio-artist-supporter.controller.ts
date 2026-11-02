import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { UpdateStudioSupporterDto } from './dto/update-studio-supporter.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioSupporterState } from './studio-supporters';
import { StudioSupportersService } from './studio-supporters.service';

/** The caller's top listener preference for one artist persona. Listeners
 *  are shown by default; these routes change the identity or hide them. */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioArtistSupporterController {
  constructor(private readonly supporters: StudioSupportersService) {}

  @Get(':subprofileId/supporter')
  @ApiOperation({ summary: "The caller's supporter state for an artist." })
  @ApiOkResponse({ description: '`StudioSupporterState`.' })
  @ApiNotFoundResponse({ description: '`studio_supporter_artist_not_found`.' })
  @ApiForbiddenResponse({ description: '`studio_supporter_own_persona`.' })
  getSupporter(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioSupporterState> {
    return this.supporters.getSupporterState(user.userId, subprofileId);
  }

  @Put(':subprofileId/supporter')
  @ApiOperation({
    summary:
      "Shows the caller among the artist's top listeners, or changes the identity",
  })
  @ApiOkResponse({ description: '`StudioSupporterState`.' })
  @ApiNotFoundResponse({ description: '`studio_supporter_artist_not_found`.' })
  @ApiForbiddenResponse({
    description:
      '`studio_supporter_own_persona` or `studio_supporter_identity_not_yours`.',
  })
  setSupporter(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Body() body: UpdateStudioSupporterDto,
  ): Promise<StudioSupporterState> {
    return this.supporters.setSupporter(
      user.userId,
      subprofileId,
      body.shownAsSubprofileId,
    );
  }

  @Delete(':subprofileId/supporter')
  @HttpCode(204)
  @ApiOperation({
    summary: "Hides the caller from the artist's top listeners",
  })
  @ApiNoContentResponse({ description: 'The caller is hidden.' })
  @ApiNotFoundResponse({
    description:
      '`studio_supporter_artist_not_found` for an unknown persona id.',
  })
  async removeSupporter(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<void> {
    await this.supporters.removeSupporter(user.userId, subprofileId);
  }
}
