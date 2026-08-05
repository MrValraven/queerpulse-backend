import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { LandingService } from './landing.service';

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
  constructor(private readonly landing: LandingService) {}

  @Public()
  @Get('features')
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  @ApiOperation({
    summary:
      'Get the live landing page payload: featured members, communities, and changemakers.',
  })
  @ApiOkResponse({
    description:
      'Active landing features per section, filtered to currently-eligible targets.',
  })
  getFeatures() {
    return this.landing.getPublicFeatures();
  }
}
