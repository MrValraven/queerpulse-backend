import { Injectable } from '@nestjs/common';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';
import { REPORT_ANONYMOUS_BURST_LIMIT } from './report-flood-limits';

/**
 * The burst limiter on `POST /reports`, which since PRD-280 serves signed-in
 * members and signed-out visitors on the same route.
 *
 * It exists because `@Throttle` is static metadata and the two callers need
 * different numbers. A signed-in filing keeps the route's declared 10/60s
 * exactly; a signed-out one is held to `REPORT_ANONYMOUS_BURST_LIMIT`, which
 * `report-flood-limits.ts` argues for. The reasoning in short: on the member
 * path the burst throttle is the layer nobody leans on, because two durable
 * layers sit behind it, and on the anonymous path it is one of two and the
 * only one that binds inside the first minute.
 *
 * ## Two buckets, never one
 *
 * The tracker is namespaced by auth state, and that is load-bearing twice
 * over. It keeps a signed-out flood from spending a signed-in member's
 * allowance when the two share an address, which behind a community centre's
 * wifi is an ordinary Tuesday. And it keeps this guard's key distinct from the
 * one the GLOBAL `HttpThrottlerGuard` derives for the same request: both
 * guards read the same `@Throttle` metadata off this handler, `generateKey`
 * hashes (class, handler, tracker), so an identical tracker string would mean
 * two increments of one counter per request and a member's real ceiling would
 * silently halve. Both branches are prefixed for that reason, including the
 * signed-in one, which is otherwise the plain client IP the global guard uses.
 *
 * The net effect on the signed-in path is therefore nil: the global guard
 * still allows 10 a minute per IP, and this guard allows 10 a minute per IP in
 * a bucket of its own, so the binding number is the same 10 it always was.
 *
 * Both branches key on the client IP, resolved through `trust proxy` in
 * `main.ts`, and keep their counters in process memory. Neither says anything
 * about sustained behaviour; the durable caps in `ReportsService` do that.
 */
@Injectable()
export class ReportFilingThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const clientAddress = typeof req.ip === 'string' ? req.ip : 'unknown';
    // `req.user` is populated by `OptionalJwtAuthGuard`, which is listed
    // BEFORE this guard in the route's `@UseGuards` so it has already run.
    const user = req.user as { userId?: string } | undefined;
    return Promise.resolve(
      user?.userId
        ? `report-file-member:${clientAddress}`
        : `report-file-anon:${clientAddress}`,
    );
  }

  protected handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const request = requestProps.context
      .switchToHttp()
      .getRequest<{ user?: { userId?: string } }>();
    if (request.user?.userId) {
      return super.handleRequest(requestProps);
    }
    // `Math.min` rather than a flat assignment, so lowering the route's
    // `@Throttle` below the anonymous number would keep lowering the anonymous
    // path too. This guard may only ever tighten.
    return super.handleRequest({
      ...requestProps,
      limit: Math.min(requestProps.limit, REPORT_ANONYMOUS_BURST_LIMIT),
    });
  }
}
