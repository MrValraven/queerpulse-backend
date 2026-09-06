import { ExecutionContext, Injectable } from '@nestjs/common';
import { seconds } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import {
  MAX_BATCH_URLS,
  UNFURL_URL_LIMIT,
  UNFURL_WINDOW_SECONDS,
} from './link-preview.constants';

/**
 * One rate bucket for every unfurl, keyed per MEMBER and counted per URL rather
 * than per request.
 *
 * The batch route exists to save round-trips on a forum thread or a feed page
 * that quotes several links. Left to the stock throttler it would also be a way
 * to spend four times the allowance, because the default `generateKey` mixes
 * the handler name into the storage key: `/link-preview` and
 * `/link-preview/batch` would get a bucket each, and each batch request would
 * count as one hit no matter how many outbound fetches it started.
 *
 * Three overrides shape the bucket:
 *  - `getTracker` names the authenticated member instead of the client IP.
 *  - `generateKey` drops the handler name, so both routes draw on the SAME
 *    bucket for a given caller.
 *  - `handleRequest` increments once per URL the request carries, so a batch of
 *    four costs exactly what four single calls cost, and carries this guard's
 *    own limit rather than reading one off the route.
 *
 * The net allowance is therefore unchanged by the batch route:
 * `UNFURL_URL_LIMIT` URLs per window, however the caller splits them.
 */
@Injectable()
export class LinkPreviewThrottlerGuard extends HttpThrottlerGuard {
  /**
   * Track the authenticated member instead of the client IP.
   *
   * The inherited IP tracker lumps everyone behind one venue's wifi, one office
   * NAT or one carrier's CGNAT into a single allowance. That is the wrong shape
   * for a queer community platform twice over: unfurling is a per-member
   * reading action, and a shared IP is precisely where members are using the app
   * together, so an IP bucket charges a room of people for each other's
   * scrolling and hands them 429s for sitting in the same cafe.
   * `UserPresignThrottlerGuard` documents the same mismatch for uploads and
   * solves it the same way; `RefreshSessionThrottlerGuard` documents it for
   * refresh, where `@Public()` leaves no user to key on.
   *
   * Per member is also STRICTER against an attacker than per IP, in the way
   * that matters: one account can no longer draw on a shared NAT's pool, and
   * cannot escape its own bucket by hopping IPs. Reaching a bigger total means
   * holding more active, vouched memberships, each individually bounded.
   *
   * `req.user` is always populated here: the global `JwtAuthGuard` fills it
   * before any controller guard runs, and both routes then sit behind
   * `ActiveMemberGuard`, which throws for anyone who is not an active member.
   * Neither route is `@Public()`, so there is no anonymous path in. The IP
   * fallback is for a shape that does not exist today (a `@Public()` route added
   * to this controller later, or the guard reused elsewhere): it keeps such a
   * request THROTTLED, on the same limit, sharing one bucket per IP. There is no
   * branch here that returns an unmetered caller.
   */
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    if (user?.userId) {
      return Promise.resolve(`link-preview-user:${user.userId}`);
    }
    return Promise.resolve(
      typeof req.ip === 'string'
        ? `link-preview-ip:${req.ip}`
        : 'link-preview-unknown',
    );
  }

  /**
   * A key that ignores which handler was hit, so the single and batch routes
   * share one counter. Still hashed, so the member id that forms the suffix is
   * not stored in plain text (the base class hashes for the same reason).
   */
  protected generateKey(
    _context: ExecutionContext,
    suffix: string,
    throttlerName: string,
  ): string {
    return createHash('sha256')
      .update(`link-preview-unfurl-${throttlerName}-${suffix}`)
      .digest('hex');
  }

  /**
   * Charge one slot per requested URL, against this guard's own limit.
   *
   * The limit is set here rather than with a `@Throttle` on the controller for
   * the reason `RefreshSessionThrottlerGuard` gives: this guard runs ALONGSIDE
   * the global IP-keyed one, and both read the same route metadata, so a
   * decorator sized for one member would land on the IP bucket too and re-create
   * the shared-venue problem this guard exists to remove. One number cannot
   * serve two populations. Carrying it here leaves the route with no `@Throttle`
   * at all, which puts the IP bucket back on the app-wide default every other
   * route already lives with, while the per-member bucket stays meaningful. The
   * tracker is part of the storage key, so the two buckets never mix.
   *
   * `super.handleRequest` throws `ThrottlerException` the moment the bucket is
   * exhausted, so a batch that runs out part-way is refused as a whole and never
   * reaches the service.
   */
  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(requestProps.context);
    const requestedUrlCount = countRequestedUrls(req);
    const perMemberProps: ThrottlerRequest = {
      ...requestProps,
      limit: UNFURL_URL_LIMIT,
      ttl: seconds(UNFURL_WINDOW_SECONDS),
      blockDuration: seconds(UNFURL_WINDOW_SECONDS),
    };
    let isAllowed = true;
    for (let charge = 0; charge < requestedUrlCount; charge += 1) {
      isAllowed = (await super.handleRequest(perMemberProps)) && isAllowed;
    }
    return isAllowed;
  }
}

/**
 * How many URLs this request is asking us to fetch, read from the raw query
 * before the `ValidationPipe` has run (guards precede pipes).
 *
 * Clamped to `MAX_BATCH_URLS`: a caller who sends fifty is rejected with a 400
 * by the DTO a moment later, and there is no reason to let the rejected request
 * empty the bucket on its way out. A request with no `url` at all still costs
 * one, so a malformed flood is not free.
 */
function countRequestedUrls(req: Record<string, unknown>): number {
  const query = req.query as Record<string, unknown> | undefined;
  const requestedUrls = query?.['url'];
  if (!Array.isArray(requestedUrls)) {
    return 1;
  }
  return Math.min(Math.max(requestedUrls.length, 1), MAX_BATCH_URLS);
}
