import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mints and verifies the opaque, per-member calendar-feed token
 * `CalendarSubscribe` (queerpulse FE) copies into "Subscribe to your feed" —
 * `<userId>.<hmac>`, where `hmac` is an HMAC-SHA256 of `userId` keyed by a
 * server secret. This is a SIGNED token, not a stored one: verifying it needs
 * no database round trip (recomputing the same HMAC and comparing), which is
 * exactly what a calendar app's "poll the feed URL every so often" pattern
 * wants — a webcal-style feed URL is meant to be fetched unauthenticated,
 * repeatedly, by a client that will never see a login prompt.
 *
 * Deliberately reuses `JWT_ACCESS_SECRET` rather than introducing a new
 * required env var: this repo's deploy story has no mechanism this task can
 * drive for provisioning a fresh secret across every environment, and the
 * access-token secret is already present and rotated with the same care a
 * feed-token secret would need. `timingSafeEqual` on verify avoids leaking
 * the expected signature through a timing side channel.
 */
@Injectable()
export class CalendarFeedTokenService {
  constructor(private readonly configService: ConfigService) {}

  mint(userId: string): string {
    return `${userId}.${this.sign(userId)}`;
  }

  /** Returns the member's `userId` when `token` is a validly-signed token
   *  minted by `mint()`, or `null` when it's malformed or tampered with. */
  verify(token: string): string | null {
    const separatorIndex = token.lastIndexOf('.');
    if (separatorIndex === -1) return null;
    const userId = token.slice(0, separatorIndex);
    const providedSignature = token.slice(separatorIndex + 1);
    const expectedSignature = this.sign(userId);
    const provided = Buffer.from(providedSignature);
    const expected = Buffer.from(expectedSignature);
    if (provided.length !== expected.length) return null;
    return timingSafeEqual(provided, expected) ? userId : null;
  }

  private sign(userId: string): string {
    const secret = this.configService.get<string>('auth.jwtAccessSecret');
    // `JWT_ACCESS_SECRET` is required (`env.validation.ts` fails boot without
    // it), so this is unreachable in a running app — the check just keeps the
    // return type `string`, not `string | undefined`, without a non-null
    // assertion.
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET is not configured');
    }
    return createHmac('sha256', secret).update(userId).digest('hex');
  }
}
