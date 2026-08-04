import {
  Controller,
  Get,
  Res,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { MetricsService } from './metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

/**
 * Prometheus scrape endpoint.
 *
 * Exposed like the health probes — `@Public()` (no session), `@SkipThrottle()`
 * (a scraper polling every 15s must never be rate-limited into a false gap), and
 * `@LockdownExempt()` (observability must survive a platform lockdown, which is
 * exactly when you need it) — and version-neutral so the scrape config targets a
 * stable `/metrics` rather than `/v1/metrics`. Unlike the health probes it is
 * additionally guarded by {@link MetricsTokenGuard}; internal, not world-readable.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@LockdownExempt()
@UseGuards(MetricsTokenGuard)
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metricsService.contentType);
    response.send(await this.metricsService.scrape());
  }
}
