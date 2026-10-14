import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { ListStudioEpisodesQuery } from './dto/list-studio-episodes.query';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioEpisodeFeed,
  StudioEpisodesService,
} from './studio-episodes.service';
import { StudioTrackResponse } from './studio-response';
import { STUDIO_LIMITS } from './studio.constants';

// Studio artist kinds: the latest-episodes shelf and one episode's publish.
// Both paths stay out of the request log, the HTTP metrics and Sentry
// (`/studio/episodes/...` and `/studio/tracks/<id>`, `studio-request-log.ts`).
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    '`studio_access_required`, `studio_not_persona_owner` or `studio_persona_kind_not_allowed`.',
})
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioEpisodesController {
  constructor(private readonly episodes: StudioEpisodesService) {}

  @Get('episodes/latest')
  @ApiOperation({
    summary: 'The newest published episodes across the shows you can hear.',
  })
  @ApiOkResponse({ description: '`{ items, nextCursor }`.' })
  listLatestEpisodes(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListStudioEpisodesQuery,
  ): Promise<StudioEpisodeFeed> {
    return this.episodes.listLatest(
      user.userId,
      query.cursor,
      query.limit ?? STUDIO_LIMITS.episodesPerPage,
    );
  }

  @Post('tracks/:id/publish')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a draft episode of a published show.' })
  @ApiOkResponse({ description: '`StudioTrack`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours to see.' })
  @ApiConflictResponse({
    description:
      '`studio_not_a_podcast`, `studio_episode_show_not_published`, `studio_episode_already_published` or `studio_publish_tracks_pending`.',
  })
  publishEpisode(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<StudioTrackResponse> {
    return this.episodes.publishEpisode(user.userId, trackId);
  }
}
