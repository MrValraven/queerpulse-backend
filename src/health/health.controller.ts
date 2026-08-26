import { Controller, Get, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle, seconds } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { MetricsTokenGuard } from '../metrics/metrics-token.guard';
import { PlatformProbesService } from './platform-probes.service';

/**
 * The LIVENESS probe is never rate-limited. The throttler guard does not honour
 * `@Public()` and keys on `req.ip`, so behind a proxy the orchestrator's probes
 * would draw from a bucket shared with other traffic resolving to that IP. A 429
 * here fails the healthcheck and gets a perfectly healthy instance killed.
 * `/health/live` is what `railway.json` actually probes, and it touches nothing
 * external, so it stays open and unthrottled at class level.
 *
 * The two DB-pinging variants (`/health` and `/health/ready`) do NOT: each takes
 * a connection from a pool whose max is 10, and Terminus puts the driver's own
 * failure text in the 503 body. They re-enable throttling per method and sit
 * behind {@link MetricsTokenGuard}, the same shared-secret gate as `/metrics`,
 * so an operator scrapes them with `Authorization: Bearer $METRICS_TOKEN`. The
 * guard is open when `METRICS_TOKEN` is unset, which is only possible outside
 * production (env validation requires it there), so local probing is unchanged.
 */
// Version-neutral: the Railway/orchestrator healthcheck probes fixed, unversioned
// paths (`/health`, `/health/live`, `/health/ready`) that cannot be changed in
// lockstep with the API version.
@ApiTags('health')
@Public()
@SkipThrottle()
@LockdownExempt()
// `version: VERSION_NEUTRAL` in the @Controller options is how Nest sets
// controller-level version metadata (the router reads it off the class); the
// standalone @Version() decorator only works at the method level.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly probes: PlatformProbesService,
  ) {}

  /**
   * Full health check (DB ping). Kept at the original path for backwards
   * compatibility with existing monitors/probes, which now need to present the
   * metrics bearer token.
   */
  @Get()
  @HealthCheck()
  @UseGuards(MetricsTokenGuard)
  @SkipThrottle({ default: false })
  @Throttle({ default: { limit: 12, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Full health check (includes a database ping)' })
  @ApiOkResponse({ description: 'The service and database are healthy.' })
  @ApiForbiddenResponse({
    description: 'Missing or wrong `Authorization: Bearer $METRICS_TOKEN`.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'A health indicator failed (e.g. the database is unreachable).',
  })
  check() {
    return this.health.check(this.probes.dependencyIndicators());
  }

  /**
   * Liveness probe: the process is up and event loop responsive. No external
   * dependencies are checked, so a slow/unreachable DB will not cause the
   * orchestrator to kill an otherwise-healthy pod. This is the one the
   * orchestrator probes, so it stays public and unthrottled.
   */
  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness probe (process up, no external checks)' })
  @ApiOkResponse({ description: 'The process is alive.' })
  live() {
    return this.health.check([]);
  }

  /**
   * Readiness probe: the app can serve traffic (database reachable). Fails when
   * the DB is down so the orchestrator stops routing requests to this instance.
   */
  @Get('ready')
  @HealthCheck()
  @UseGuards(MetricsTokenGuard)
  @SkipThrottle({ default: false })
  @Throttle({ default: { limit: 12, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Readiness probe (database reachable)' })
  @ApiOkResponse({ description: 'The instance can serve traffic.' })
  @ApiForbiddenResponse({
    description: 'Missing or wrong `Authorization: Bearer $METRICS_TOKEN`.',
  })
  @ApiServiceUnavailableResponse({
    description: 'The database is unreachable; stop routing traffic here.',
  })
  ready() {
    return this.health.check(this.probes.dependencyIndicators());
  }
}
