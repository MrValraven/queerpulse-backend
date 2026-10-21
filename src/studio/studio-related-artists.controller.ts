import {
  Controller,
  Get,
  Header,
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
import { StudioRelatedArtistsService } from './studio-related-artists.service';
import { StudioArtistRef } from './studio-response';
import { StudioSceneEvent } from './studio-scene-response';
import { StudioScenesService } from './studio-scenes.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioRelatedArtistsController {
  constructor(
    private readonly related: StudioRelatedArtistsService,
    private readonly scenes: StudioScenesService,
  ) {}

  // The score moves slowly and reads nothing personal, so a short private
  // cache matches the frontend's five-minute staleTime.
  @Get(':subprofileId/related')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({ summary: 'Up to eight related artists from public data.' })
  @ApiOkResponse({ description: '`{ items: StudioArtistRef[] }`.' })
  @ApiNotFoundResponse({ description: 'The artist is not listenable.' })
  listRelated(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<{ items: StudioArtistRef[] }> {
    return this.related.listRelated(user.userId, subprofileId);
  }

  // PRD-15: public events only, read with the viewer's blocks, so the same
  // short private cache as Related artists.
  @Get(':subprofileId/events')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary:
      'Up to four upcoming public events the artist lists, soonest first.',
  })
  @ApiOkResponse({ description: '`{ items: StudioSceneEvent[] }`.' })
  @ApiNotFoundResponse({ description: 'The artist is not listenable.' })
  listEvents(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<{ items: StudioSceneEvent[] }> {
    return this.scenes.listArtistEvents(user.userId, subprofileId);
  }
}
