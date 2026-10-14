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
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioAppearsOnCard,
  StudioAppearsOnService,
} from './studio-appears-on.service';
import { StudioPage } from './studio-response';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioArtistAppearsOnController {
  constructor(private readonly appearsOn: StudioAppearsOnService) {}

  @Get(':subprofileId/appears-on')
  @ApiOperation({ summary: 'Releases where this artist holds a credit.' })
  @ApiOkResponse({ description: '`StudioPage<StudioAppearsOnCard>`.' })
  @ApiNotFoundResponse({ description: 'The artist is not listenable.' })
  listAppearsOn(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioAppearsOnCard>> {
    return this.appearsOn.listAppearsOn(
      user.userId,
      subprofileId,
      query.cursor,
    );
  }
}
