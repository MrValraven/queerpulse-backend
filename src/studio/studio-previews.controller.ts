import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPreviewsService } from './studio-previews.service';
import { StudioPreviewResult, StudioStream } from './studio-response';

// Studio v3 private preview links, for any granted member holding one. No
// `ParseUUIDPipe` on the track id: every failure here answers the same 404
// (`studio_preview_not_found`), a malformed id included. The request log,
// metrics and Sentry skip `/studio/previews/` (`studio-request-log.ts`).
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/previews')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
@Throttle({ default: { limit: 30, ttl: seconds(60) } })
export class StudioPreviewsController {
  constructor(private readonly previews: StudioPreviewsService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'A release shared through a preview link.' })
  @ApiOkResponse({ description: '`StudioPreviewResult`.' })
  @ApiNotFoundResponse({ description: '`studio_preview_not_found`.' })
  getPreview(
    @CurrentUser() user: CurrentUserData,
    @Param('token') token: string,
  ): Promise<StudioPreviewResult> {
    return this.previews.getPreview(user.userId, token);
  }

  @Get(':token/tracks/:trackId/stream')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A signed URL for a previewed track.',
    description:
      "The URL lives for the track's length plus ten minutes (15 minutes to 6 hours; 15 minutes when the length is unknown).",
  })
  @ApiOkResponse({ description: '`StudioStream`.' })
  @ApiNotFoundResponse({ description: '`studio_preview_not_found`.' })
  getPreviewStream(
    @CurrentUser() user: CurrentUserData,
    @Param('token') token: string,
    @Param('trackId') trackId: string,
  ): Promise<StudioStream> {
    return this.previews.getPreviewStream(user.userId, token, trackId);
  }
}
