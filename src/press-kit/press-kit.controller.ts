import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PressKitService } from './press-kit.service';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

// Public, read-only payload backing the `/about/press-kit` page. `@Public()`
// is required: `JwtAuthGuard` is bound globally via `APP_GUARD`, so without it
// a logged-out visitor (or a journalist) would be rejected before reaching the
// handler — same pattern as `LandingController`.
//
// The facts are recomputed from live counts on every read and the lists are
// filtered per-request, so the payload is per-request-honest — safe to give a
// short positive `Cache-Control` (same precedent as `LandingController`).
@ApiTags('Press kit')
@Controller('press-kit')
export class PressKitController {
  constructor(private readonly pressKit: PressKitService) {}

  @Public()
  @Get()
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({
    summary:
      'Get the public press kit: derived headline facts, press coverage, and press contacts.',
  })
  @ApiOkResponse({
    description:
      'Facts derived from live DB counts, plus the active coverage and contact lists ordered by position.',
  })
  getPressKit() {
    return this.pressKit.getPressKit();
  }
}
