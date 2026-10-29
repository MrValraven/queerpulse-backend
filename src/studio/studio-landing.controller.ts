import { Controller, Get, Header, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import {
  NO_STALE_READ_CDN_CACHE,
  PUBLIC_READ_CACHE,
} from '../common/public-read-cache';
import { StudioLandingReadService } from './studio-landing-read.service';
import {
  StudioLandingPreviewStream,
  StudioLandingResponse,
} from './studio-landing-response';
import { studioError } from './studio.constants';

/**
 * The public Studio page: it serves strangers, so both routes carry
 * `@Public()` and no guard. Their reads stay out of the request log, the HTTP
 * metrics and Sentry (`studio-landing-request-log.ts`).
 *
 * The CDN keeps no stale window (`NO_STALE_READ_CDN_CACHE`) because previews,
 * cards and photos can be withdrawn, and a withdrawn item must leave the page
 * within the minute. A malformed preview id reads as an unknown one: the same
 * 404 `studio_landing_preview_unavailable`.
 */
@Feature('studio')
@ApiTags('Studio')
@Controller('studio/landing')
export class StudioLandingController {
  constructor(private readonly landing: StudioLandingReadService) {}

  @Public()
  @Get()
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', NO_STALE_READ_CDN_CACHE)
  @ApiOperation({
    summary: 'The public Studio page: counts, previews, artist cards and more.',
  })
  @ApiOkResponse({ description: '`StudioLandingResponse`.' })
  getLanding(): Promise<StudioLandingResponse> {
    return this.landing.getPublicLanding();
  }

  @Public()
  @Get('previews/:previewId/stream')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A short-lived stream link for one live preview.',
  })
  @ApiOkResponse({ description: '`StudioLandingPreviewStream`.' })
  @ApiNotFoundResponse({ description: '`studio_landing_preview_unavailable`.' })
  getPreviewStream(
    @Param(
      'previewId',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          studioError('studio_landing_preview_unavailable'),
      }),
    )
    previewId: string,
  ): Promise<StudioLandingPreviewStream> {
    return this.landing.getPreviewStream(previewId);
  }
}
