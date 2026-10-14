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

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioRelatedArtistsController {
  constructor(private readonly related: StudioRelatedArtistsService) {}

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
}
