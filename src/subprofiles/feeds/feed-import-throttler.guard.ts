import { ExecutionContext, Injectable } from '@nestjs/common';
import { seconds } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { HttpThrottlerGuard } from '../../security/http-throttler.guard';

/** Outbound feed fetches (preview, connect, manual sync) one member may start
 *  per window, across all three routes. */
export const FEED_FETCH_LIMIT = 20;
export const FEED_FETCH_WINDOW_SECONDS = 60;

/**
 * One per-MEMBER rate bucket for every persona-feed route that makes an
 * outbound fetch, modelled on `LinkPreviewThrottlerGuard`:
 *  - `getTracker` keys on the authenticated member, not the client IP, so a
 *    room of members on one venue's wifi does not share an allowance, and one
 *    account cannot escape its bucket by hopping IPs;
 *  - `generateKey` drops the handler name, so preview, connect and sync draw
 *    on the SAME bucket;
 *  - `handleRequest` carries this guard's own limit instead of a route
 *    `@Throttle`, which the global IP-keyed guard would also read.
 * The global IP bucket stays at the app-wide default on top of this.
 */
@Injectable()
export class FeedImportThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    if (user?.userId) {
      return Promise.resolve(`feed-import-user:${user.userId}`);
    }
    return Promise.resolve(
      typeof req.ip === 'string'
        ? `feed-import-ip:${req.ip}`
        : 'feed-import-unknown',
    );
  }

  protected generateKey(
    _context: ExecutionContext,
    suffix: string,
    throttlerName: string,
  ): string {
    return createHash('sha256')
      .update(`feed-import-${throttlerName}-${suffix}`)
      .digest('hex');
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: FEED_FETCH_LIMIT,
      ttl: seconds(FEED_FETCH_WINDOW_SECONDS),
      blockDuration: seconds(FEED_FETCH_WINDOW_SECONDS),
    });
  }
}
