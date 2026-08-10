import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PressKitService } from './press-kit.service';

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
  @Header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
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
