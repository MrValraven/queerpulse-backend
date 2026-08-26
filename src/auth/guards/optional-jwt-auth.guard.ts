import { Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Best-effort JWT authentication: attaches `req.user` when the request carries
 * a valid access-token cookie, but — unlike {@link JwtAuthGuard} — never
 * rejects the request when it doesn't. It always lets the handler run.
 *
 * Used wherever a route serves both anonymous and signed-in callers: the
 * `POST /intakes/:kind` form endpoint (`submitterId` ends up null for a
 * visitor), the public directory reads, `GET /files/*key`, and the platform
 * status probe. Every such route is also marked `@Public()` so the globally
 * bound mandatory `JwtAuthGuard` skips it — otherwise a logged-out visitor
 * would be blocked before ever reaching here.
 *
 * A missing, malformed, or expired token simply yields an anonymous request
 * (`req.user === undefined`) rather than a 401.
 *
 * This is the ONE optional-auth guard in the codebase. `storage/` used to keep
 * a second class of the same name; two identically-named guards are a trap for
 * anyone reading a `@UseGuards(OptionalJwtAuthGuard)` line and reasoning about
 * which behaviour applies.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(OptionalJwtAuthGuard.name);

  handleRequest<TUser = CurrentUserData>(
    error: unknown,
    user: TUser | false,
  ): TUser | undefined {
    // Swallow the error/no-user cases: passport hands `false` (no/invalid
    // token) or a populated principal. Returning `undefined` instead of
    // throwing is what makes auth optional; `AuthGuard.canActivate` then
    // assigns it to `req.user` and resolves `true` regardless.
    //
    // But swallowing an ERROR silently made an infrastructure failure (e.g.
    // `JwtStrategy.validate`'s DB check throwing during an outage)
    // indistinguishable from "not logged in": a gated read would surface as a
    // 401 permissions bug instead of the 500 database incident it actually is.
    // Logging keeps the behaviour (anonymous fallback) while making the cause
    // visible.
    if (error) {
      this.logger.error(
        'JWT validation errored; treating request as anonymous',
        error instanceof Error ? error.stack : error,
      );
    }
    return user || undefined;
  }
}
