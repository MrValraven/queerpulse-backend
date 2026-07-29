import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';

/**
 * Probes are never rate-limited. The throttler guard does not honour `@Public()`
 * and keys on `req.ip`, so behind a proxy the orchestrator's probes would draw
 * from a bucket shared with other traffic resolving to that IP. A 429 here fails
 * the healthcheck and gets a perfectly healthy instance killed.
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
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  /**
   * Full health check (DB ping). Kept at the original path for backwards
   * compatibility with existing monitors/probes.
   */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }

  /**
   * Liveness probe: the process is up and event loop responsive. No external
   * dependencies are checked, so a slow/unreachable DB will not cause the
   * orchestrator to kill an otherwise-healthy pod.
   */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /**
   * Readiness probe: the app can serve traffic (database reachable). Fails when
   * the DB is down so the orchestrator stops routing requests to this instance.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }
}
