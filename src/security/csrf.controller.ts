import { Controller, Get, Req, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { csrfCookieName, isWellFormedCsrfToken } from './csrf-cookie';

// Outlive the 30d refresh token, so the CSRF cookie is never the reason a
// still-authenticated session starts failing. Previously this was a session
// cookie while the auth cookies persisted: after a browser restart the user was
// still logged in but had no CSRF cookie, so their first mutation 403'd until
// the SPA re-fetched a token.
const CSRF_MAX_AGE = 31 * 24 * 60 * 60 * 1000; // 31d

// Version-neutral: the SPA fetches `/csrf-token` directly (not through the
// versioned request builder) to bootstrap CSRF protection, so this path must
// stay unprefixed.
@ApiTags('security')
@Public()
@LockdownExempt()
// `version: VERSION_NEUTRAL` in the @Controller options is how Nest sets
// controller-level version metadata (the standalone @Version() only works at
// the method level).
@Controller({ path: 'csrf-token', version: VERSION_NEUTRAL })
export class CsrfController {
  constructor(private readonly config: ConfigService) {}

  /**
   * GET is a safe method, so CsrfGuard lets it through; @Public skips
   * JwtAuthGuard.
   *
   * IDEMPOTENT. When the caller already presents a well-formed token cookie we
   * echo THAT value instead of minting a new one. Rotating on every call broke
   * every other tab: the double-submit check compares the header a tab is
   * holding in memory against the current cookie, so a second tab bootstrapping
   * its own token invalidated the first tab's, whose next mutation 403'd. That
   * is the desync behind the spurious "session expired" the SPA now self-heals
   * from, and this removes the cause rather than relying on the retry.
   *
   * The cookie is still re-set so its 31-day expiry slides forward. Rotation
   * happens where it actually matters: the routes that clear the cookie
   * (`clearCsrfCookie`) are `logout` and the under-18 disclosure lockout, so
   * the next fetch after a sign-out mints a fresh one. This used to name
   * `logout-all` too; that route was removed on 2026-08-26.
   */
  @Get()
  @ApiOperation({
    summary: 'Issue a CSRF token (also set as the csrf_token cookie)',
  })
  @ApiOkResponse({
    description:
      'The CSRF token to echo in the X-CSRF-Token header on state-changing requests.',
  })
  issue(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { csrfToken: string } {
    const isProduction =
      this.config.get<string>('app.nodeEnv') === 'production';
    const cookieName = csrfCookieName(this.config.get<string>('app.nodeEnv'));
    const existing: unknown = req.cookies?.[cookieName];
    const token = isWellFormedCsrfToken(existing)
      ? existing
      : randomBytes(32).toString('hex');
    // In production the `__Host-` prefix hardens this against cookie fixation
    // (see csrf-cookie.ts). The prefix's own rules — Secure, Path=/, host-only —
    // are exactly the attributes we already set, so the name switch is the only
    // change: `secure` is already tied to production, `path` is '/', and we
    // never attach a Domain.
    res.cookie(cookieName, token, {
      httpOnly: false, // the SPA must read it to echo in the X-CSRF-Token header
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: CSRF_MAX_AGE,
    });
    return { csrfToken: token };
  }
}
