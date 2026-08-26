import { Injectable, Logger } from '@nestjs/common';
import {
  type HealthIndicatorFunction,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * The one place that says WHAT this platform probes when asked whether it is
 * healthy. Two very different surfaces read it:
 *
 *  - `HealthController` hands the indicator functions straight to Terminus, so
 *    the orchestrator keeps getting the exact Terminus response shape (and the
 *    exact 503 behaviour) it has always got.
 *  - `StatusService` runs the same functions and reduces each one to a single
 *    reachable/unreachable bit for the PUBLIC status page, discarding every
 *    detail Terminus attaches (driver error text, timings, connection names).
 *
 * Keeping the probe list here is what stops those two drifting: adding a probe
 * to `PLATFORM_PROBE_KEYS` updates the orchestrator's readiness check and the
 * public status page in one edit.
 */

export const DATABASE_PROBE_KEY = 'database';

/**
 * Every dependency probed by the readiness path. Ordered, and the order is the
 * order `probeDependencies()` reports outcomes in.
 */
export const PLATFORM_PROBE_KEYS = [DATABASE_PROBE_KEY] as const;

export type PlatformProbeKey = (typeof PLATFORM_PROBE_KEYS)[number];

/**
 * A probe reduced to the only thing a public caller is ever told about it. No
 * message, no timing, no driver text — see `StatusService` for why.
 */
export interface PlatformProbeOutcome {
  key: PlatformProbeKey;
  isReachable: boolean;
}

@Injectable()
export class PlatformProbesService {
  private readonly logger = new Logger(PlatformProbesService.name);

  constructor(private readonly database: TypeOrmHealthIndicator) {}

  /**
   * The Terminus indicator function for one probe. Terminus 11 indicators
   * RESOLVE with `{ [key]: { status: 'up' | 'down', … } }` rather than throwing
   * on failure, which is what `probeDependencies()` below relies on.
   */
  private indicatorFor(key: PlatformProbeKey): HealthIndicatorFunction {
    switch (key) {
      case DATABASE_PROBE_KEY:
      default:
        // No options: the default 1000ms ping timeout is what `/health` and
        // `/health/ready` have always used, and changing it here would change
        // what the orchestrator kills.
        return () => this.database.pingCheck(DATABASE_PROBE_KEY);
    }
  }

  /** The indicator list `HealthCheckService.check()` consumes. */
  dependencyIndicators(): HealthIndicatorFunction[] {
    return PLATFORM_PROBE_KEYS.map((key) => this.indicatorFor(key));
  }

  /**
   * Run every dependency probe and reduce each to reachable/unreachable.
   *
   * NEVER REJECTS. The public status endpoint is the one surface that has to
   * keep answering while the thing it describes is broken, so a probe that
   * throws (rather than resolving `down`) is caught here and reported as
   * unreachable. Probes run concurrently, so total latency is the slowest
   * probe's timeout rather than their sum.
   */
  async probeDependencies(): Promise<PlatformProbeOutcome[]> {
    return Promise.all(
      PLATFORM_PROBE_KEYS.map(async (key) => this.probeOne(key)),
    );
  }

  private async probeOne(key: PlatformProbeKey): Promise<PlatformProbeOutcome> {
    try {
      const result = await this.indicatorFor(key)();
      const entry = (result as Record<string, { status?: string }>)[key];
      return { key, isReachable: entry?.status === 'up' };
    } catch (error) {
      // Logged at warn, never returned to the caller: the driver's failure text
      // routinely carries a host, a port and a database name.
      this.logger.warn(
        `Platform probe "${key}" threw: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return { key, isReachable: false };
    }
  }
}
