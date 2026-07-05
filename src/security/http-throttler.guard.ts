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
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }
}
