import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../security/skip-csrf.decorator';
import { RecordLandingVisitDto } from './dto/record-landing-visit.dto';
import { LandingService } from './landing.service';
import { LandingVisitsService } from './landing-visits.service';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

// Public, read-only payload backing the live landing page. `@Public()` is
// required: `JwtAuthGuard` is bound globally via `APP_GUARD`, so without it a
// logged-out visitor would be rejected before reaching the handler — same
// pattern as `ChangemakersController`.
//
// The response applies the canonical eligibility filter at read time (see
// `LandingService.getPublicFeatures`), so it is per-request-honest rather
// than per-caller-scoped — safe to give a short positive `Cache-Control`
// (same precedent as `ChangemakersController`).
@ApiTags('Landing')
@Controller('landing')
export class LandingController {
  constructor(
    private readonly landing: LandingService,
    private readonly landingVisits: LandingVisitsService,
  ) {}

  @Public()
  @Get('features')
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({
    summary:
      'Get the live landing page payload: featured members, communities, changemakers, events and stories.',
  })
  @ApiOkResponse({
    description:
      'Active landing features per section, filtered to currently-eligible targets.',
  })
  getFeatures() {
    return this.landing.getPublicFeatures();
  }

  // @SkipCsrf: this route reads no session and no cookie, it only bumps an
  // anonymous (day, source) counter, so there is no ambient credential for a
  // forged request to ride on. With CSRF skipped, the content type is the
  // guard against inflated counts: only an `application/json` POST is counted,
  // because JSON forces a CORS preflight and so the origin allowlist applies.
  // A `text/plain` or form POST is a simple request any site can send, and it
  // writes nothing. Always 204, bots and skipped requests included, so the
  // response never reveals either filter. The user agent is read for the bot
  // filter only. The throttle allows 30 a minute per IP: carrier-grade NAT
  // puts many visitors behind one address.
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Post('visits')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Count one anonymous landing page visit for a source.',
  })
  @ApiNoContentResponse({ description: 'The visit was counted or skipped.' })
  async recordVisit(
    @Body() dto: RecordLandingVisitDto,
    @Headers('user-agent') userAgent?: string,
    @Headers('content-type') contentType?: string,
  ): Promise<void> {
    await this.landingVisits.record(dto.source, userAgent, contentType);
  }
}
