import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUserData } from '../decorators/current-user.decorator';

/**
 * Best-effort JWT authentication: attaches `req.user` when the request carries
 * a valid access-token cookie, but — unlike {@link JwtAuthGuard} — never
 * rejects the request when it doesn't. It always lets the handler run.
 *
 * Used on the single `POST /intakes/:kind` endpoint, which serves both public
 * marketing forms (a logged-out visitor may submit; `submitterId` ends up null)
 * and member-only forms (the handler itself requires a user). The route is also
 * marked `@Public()` so the globally-bound mandatory `JwtAuthGuard` skips it —
 * otherwise a logged-out visitor would be blocked before ever reaching here.
 *
 * A missing, malformed, or expired token simply yields an anonymous request
 * (`req.user === undefined`) rather than a 401.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = CurrentUserData>(
    _err: unknown,
    user: TUser | false,
  ): TUser | undefined {
    // Swallow the error/no-user cases: passport hands `false` (no/invalid
    // token) or a populated principal. Returning `undefined` instead of
    // throwing is what makes auth optional; `AuthGuard.canActivate` then
    // assigns it to `req.user` and resolves `true` regardless.
    return user || undefined;
  }
}
