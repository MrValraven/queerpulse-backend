import { Injectable } from '@nestjs/common';
import { seconds } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { CurrentUserData } from './decorators/current-user.decorator';

/**
 * How many `POST /auth/socket-ticket` mints we allow per signed-in member per
 * window.
 *
 * Mirrors `ChatGateway.reauthLimiter`'s own numbers deliberately (capacity
 * 10, generous relative to expected use). A ticket is expected roughly once
 * per open socket per access-token TTL (around 15 minutes), and every
 * successful redemption re-arms that socket's own expiry timer, so a healthy
 * client mints at most a handful of tickets an hour even across several open
 * tabs. 10 per 60s sits far above that legitimate ceiling, leaving headroom
 * for a client retrying a few times after a transient mint failure across
 * several tabs, while still bounding what minting can turn into: each mint
 * is cheap on its own (no DB round trip; see `SocketTicketService.mint`),
 * but every ticket a client actually redeems costs
 * `ChatGateway.handleReauth`'s own `assertClaimsAdmitted` DB work, and
 * unlimited minting would be a way to manufacture unlimited redemption
 * attempts against that cost, on top of `reauthLimiter`'s own bound on the
 * SOCKET side of that same spend.
 */
const SOCKET_TICKET_MINT_LIMIT = 10;
const SOCKET_TICKET_MINT_WINDOW_MS = seconds(60);

/**
 * Per-MEMBER limiter for `POST /auth/socket-ticket`, mirroring
 * `RefreshSessionThrottlerGuard`'s reasoning for why the global IP-keyed
 * throttler is the wrong shape here: minting is a per-member action, and
 * without this, a shared IP (a venue's wifi, an office NAT) would let one
 * member's flood exhaust the bucket for everyone else behind the same
 * address.
 *
 * Unlike `RefreshSessionThrottlerGuard` (which is `@Public()` and so has no
 * `request.user` to key on), `POST /auth/socket-ticket` is NOT `@Public()`.
 * It runs behind the global `JwtAuthGuard`, which is bound as an `APP_GUARD`
 * and therefore always executes BEFORE this route-level guard regardless of
 * decorator order. `request.user` is guaranteed populated by the time this
 * guard runs, so the tracker keys on the verified user id directly rather
 * than hashing a cookie the way the refresh guard has to.
 *
 * Extends `HttpThrottlerGuard` to inherit its non-HTTP skip and
 * `@SkipThrottle()` handling, bound with `@UseGuards` on the route.
 */
@Injectable()
export class SocketTicketThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as CurrentUserData | undefined;
    if (user?.userId) {
      return Promise.resolve(`socket-ticket:${user.userId}`);
    }
    // Should be unreachable (the global JwtAuthGuard already refused an
    // unauthenticated request before this guard ever runs), but a tracker
    // must always resolve to SOMETHING rather than throw. Falls back to the
    // client IP, matching `RefreshSessionThrottlerGuard`'s own fallback.
    return Promise.resolve(
      typeof req.ip === 'string' ? req.ip : 'socket-ticket-unknown',
    );
  }

  /**
   * Carries its own limit rather than a route-level `@Throttle` decorator,
   * the same reasoning as `RefreshSessionThrottlerGuard.handleRequest`: this
   * guard runs ALONGSIDE the global IP-keyed default throttler, and both
   * read the same decorator metadata, so a decorator tight enough to bound
   * one member would also land on the shared-IP bucket. Setting the limit
   * here keeps the route undecorated, leaving the IP bucket at the app-wide
   * default while this per-member bucket stays tight.
   */
  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: SOCKET_TICKET_MINT_LIMIT,
      ttl: SOCKET_TICKET_MINT_WINDOW_MS,
      blockDuration: SOCKET_TICKET_MINT_WINDOW_MS,
    });
  }
}
