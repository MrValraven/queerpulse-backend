import { ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';

/** The cookie `setAuthCookies` writes the access token to. */
const ACCESS_TOKEN_COOKIE = 'access_token';

/**
 * How long after its expiry an access token still names its member for
 * throttling. A browser calls `/auth/refresh` right after the token lapses, so
 * the hour keeps that call (and the retries around it) in the member's own
 * bucket. Authentication itself still refuses the expired token.
 */
const EXPIRED_TOKEN_GRACE_SECONDS = 60 * 60;

/** Verifies signatures only; it holds no secret of its own. */
const accessTokenVerifier = new JwtService();

interface AccessTokenClaims {
  sub?: unknown;
  email?: unknown;
  exp?: unknown;
}

/**
 * Rate limiting only makes sense over HTTP here. The base `ThrottlerGuard`
 * calls `context.switchToHttp()` unconditionally and then `res.header(...)`,
 * which throws on WebSocket contexts (a socket.io `Socket` has no `res.header`).
 * Bound as a global guard it would therefore break every `@SubscribeMessage`
 * handler. Skip non-HTTP contexts here — WebSocket traffic is rate-limited
 * inside the gateway instead (per-socket, keyed on the authenticated user).
 *
 * Mirrors the `context.getType() !== 'http'` guard used by `CsrfGuard` and
 * `JwtAuthGuard`.
 *
 * Delegating to `super.shouldSkip` is load-bearing: that is where `@SkipThrottle()`
 * is read. Overriding it outright silently disabled the decorator everywhere it
 * was used — including the Mux webhook, which is HMAC-authenticated and must not
 * be throttled on a burst of provider callbacks.
 *
 * Bucket key (PRD-501): a request carrying a validly signed access token is
 * counted per member (`member:<id>`), so members sharing a venue's Wi-Fi or a
 * carrier's CGNAT each get their own bucket; every other request is counted per
 * client IP, as `ThrottlerGuard` does by default. The global guard runs before
 * `JwtAuthGuard`, so the token is checked here: signature and algorithm only,
 * since this picks a bucket and grants nothing. A forged token fails the
 * signature and falls back to the IP. Every per-route `@Throttle` limit on the
 * global guard keys the same way; the dedicated throttler subclasses override
 * `getTracker` and keep their own keys.
 *
 * The config arrives by property injection so subclasses keep the base
 * constructor. Without it (a spec building a guard by hand) every request is
 * counted per IP.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(ConfigService)
  protected throttlerConfig?: ConfigService;

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.shouldSkip(context);
  }

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const memberId = this.signedInMemberId(req);
    if (memberId) return Promise.resolve(`member:${memberId}`);
    return super.getTracker(req);
  }

  /** The member a validly signed access-token cookie names, or null. */
  private signedInMemberId(req: Record<string, unknown>): string | null {
    const secret = this.throttlerConfig?.get<string>('auth.jwtAccessSecret');
    const cookies = req.cookies as
      Record<string, string | undefined> | undefined;
    const token = cookies?.[ACCESS_TOKEN_COOKIE];
    if (!secret || !token) return null;
    try {
      const claims = accessTokenVerifier.verify<AccessTokenClaims>(token, {
        secret,
        algorithms: ['HS256'],
        ignoreExpiration: true,
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        typeof claims.sub !== 'string' ||
        claims.sub.length === 0 ||
        typeof claims.email !== 'string' ||
        typeof claims.exp !== 'number' ||
        claims.exp + EXPIRED_TOKEN_GRACE_SECONDS < nowSeconds
      ) {
        return null;
      }
      return claims.sub;
    } catch {
      return null;
    }
  }
}
