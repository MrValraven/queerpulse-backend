import { Injectable } from '@nestjs/common';
import { seconds } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';

/**
 * How many presentations of ONE refresh credential we allow per window.
 *
 * Far above any legitimate use, deliberately. A healthy browser rotates roughly
 * every 15 minutes and each successful rotation mints a NEW cookie, so a real
 * device presents a fresh key every time and effectively never accumulates a
 * count at all. The only thing that can reach this number is the same token
 * being presented over and over: a client stuck in a retry loop, or a stolen
 * token being replayed. Reuse detection in `AuthService.rotateRefreshToken` is
 * the actual answer to theft; this bucket exists so a loop cannot spend the
 * database while that answer is being reached.
 */
const REFRESH_LIMIT = 20;
const REFRESH_WINDOW_MS = seconds(60);

/**
 * Per-SESSION limiter for `POST /auth/refresh`.
 *
 * The global throttler keys on client IP, which lumps every member behind one
 * venue's wifi, one office NAT or one carrier's CGNAT into a single bucket.
 * That is the wrong shape for this route twice over: renewing a session is a
 * per-member action, and refresh is the one call a signed-in browser cannot do
 * without, so a shared-IP 429 here does not slow an attacker down, it signs a
 * room full of co-located members out. `UserPresignThrottlerGuard` documents the
 * same mismatch for uploads and solves it the same way.
 *
 * Refresh cannot key on the user id the way presign does: it is `@Public()`, so
 * `request.user` is never populated, and the whole premise of the call is that
 * the access token identifying the member may already have expired. The only
 * identity a refresh request carries is the presenting `refresh_token` cookie,
 * so that is what we track.
 *
 * The tracker is a SHA-256 of the cookie, never the cookie itself. A throttler
 * key is held in the storage backend and can surface in diagnostics, and a raw
 * refresh token is a 30-day credential: putting it there would turn the rate
 * limiter into a second, less guarded copy of the token store. Hashing keeps the
 * key stable per credential while making it useless to anybody who reads it.
 * Nothing here logs the cookie or the hash.
 *
 * A request with no cookie falls back to the client IP. Those are rejected by
 * the handler before any work happens, and they carry nothing else to key on.
 *
 * Extends HttpThrottlerGuard to inherit its non-HTTP skip and its
 * `@SkipThrottle()` handling, then bound with @UseGuards on the refresh route.
 */
@Injectable()
export class RefreshSessionThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const cookies = req.cookies as
      Record<string, string | undefined> | undefined;
    const presentedRefreshToken = cookies?.['refresh_token'];
    if (presentedRefreshToken) {
      const fingerprint = createHash('sha256')
        .update(presentedRefreshToken)
        .digest('hex');
      return Promise.resolve(`refresh-session:${fingerprint}`);
    }
    return Promise.resolve(
      typeof req.ip === 'string' ? req.ip : 'refresh-unknown',
    );
  }

  /**
   * Carry this guard's own limit rather than the route's `@Throttle` metadata.
   *
   * This guard runs ALONGSIDE the global IP-keyed one, and both of them read the
   * same `@Throttle` on the handler. So a decorator tight enough to be a useful
   * per-credential bound would land on the IP bucket as well and re-create the
   * exact problem this guard exists to remove: one number cannot serve two
   * populations, because a limit that is generous for a single browser is
   * absurdly tight for four hundred members sharing a venue's NAT.
   *
   * Setting the limit here instead lets the route carry no `@Throttle` at all,
   * which leaves the IP bucket at the app-wide default that every other route
   * already lives with, while the per-credential bucket stays tight. The tracker
   * is part of the storage key (`generateKey`), so the two buckets never mix.
   */
  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: REFRESH_LIMIT,
      ttl: REFRESH_WINDOW_MS,
      blockDuration: REFRESH_WINDOW_MS,
    });
  }
}
