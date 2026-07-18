import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.shouldSkip(context);
  }
}
