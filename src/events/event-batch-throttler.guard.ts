import { Injectable } from '@nestjs/common';
import { seconds } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';

/**
 * How many `POST /events/batch` requests one member may send per window.
 * A batch writes up to 31 events, their host seats and the notifications in
 * one request, so five per ten minutes leaves room for a host to fix a typo
 * and resend while bounding how much one account can publish at once.
 */
export const EVENT_BATCH_THROTTLE_LIMIT = 5;
export const EVENT_BATCH_THROTTLE_WINDOW_MS = seconds(600);

/**
 * Per-MEMBER limiter for `POST /events/batch`. Staff of one venue often
 * share a public address, so the app-wide IP-keyed throttler would make them
 * split a single allowance. A route-level `@Throttle` would also tighten
 * that shared IP bucket, because both throttlers read the same decorator
 * metadata. This guard keeps its own limit in `handleRequest`, leaves the
 * route undecorated, and lets the 429 stay the throttler's own uncoded
 * answer.
 *
 * The route runs behind the global `JwtAuthGuard`, which executes before any
 * route-level guard, so `request.user` is populated by the time the tracker
 * reads it. Extends `HttpThrottlerGuard` to inherit its non-HTTP skip and
 * `@SkipThrottle()` handling. Bound with `@UseGuards` on
 * `EventsController.createBatch` and provided by `EventsModule`.
 */
@Injectable()
export class EventBatchThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(request: Record<string, unknown>): Promise<string> {
    const user = request.user as CurrentUserData | undefined;
    if (user?.userId) {
      return Promise.resolve(`event-batch:${user.userId}`);
    }
    // Unreachable after the global JwtAuthGuard, but a tracker must always
    // resolve to something, so it falls back to the client address.
    return Promise.resolve(
      typeof request.ip === 'string' ? request.ip : 'event-batch-unknown',
    );
  }

  /**
   * Carries its own limit so the route needs no `@Throttle` decorator: the
   * decorator metadata is shared with the global IP-keyed throttler, and a
   * tight value there would shrink the venue's shared address bucket too.
   */
  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: EVENT_BATCH_THROTTLE_LIMIT,
      ttl: EVENT_BATCH_THROTTLE_WINDOW_MS,
      blockDuration: EVENT_BATCH_THROTTLE_WINDOW_MS,
    });
  }
}
