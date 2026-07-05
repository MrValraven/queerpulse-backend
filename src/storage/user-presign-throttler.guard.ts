import { Injectable } from '@nestjs/common';
import { HttpThrottlerGuard } from '../security/http-throttler.guard';

/**
 * Per-user presign limiter. The global throttler keys on client IP, which
 * lumps every member behind a shared NAT/CGNAT into one bucket. Presign is an
 * authenticated, per-user action that mints short-lived write credentials to
 * object storage, so track by user id instead — each member gets their own
 * quota, and a single compromised session cannot fan out unbounded upload
 * slots by hopping IPs. Falls back to the client IP for any unauthenticated
 * edge (there should be none: these routes sit behind JwtAuthGuard).
 *
 * Extends HttpThrottlerGuard to inherit its non-HTTP skip, then bound with
 * @UseGuards on the uploads controller (running alongside the global guard).
 */
@Injectable()
export class UserPresignThrottlerGuard extends HttpThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    if (user?.userId) {
      return Promise.resolve(`presign-user:${user.userId}`);
    }
    return Promise.resolve(
      typeof req.ip === 'string' ? req.ip : 'presign-unknown',
    );
  }
}
