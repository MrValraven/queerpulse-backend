import { Controller, Get, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { csrfCookieName } from './csrf-cookie';

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

  // GET is a safe method, so CsrfGuard lets it through; @Public skips JwtAuthGuard.
  @Get()
  @ApiOperation({
    summary: 'Issue a CSRF token (also set as the csrf_token cookie)',
  })
  @ApiOkResponse({
    description:
      'The CSRF token to echo in the X-CSRF-Token header on state-changing requests.',
  })
  issue(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = randomBytes(32).toString('hex');
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';
    // In production the `__Host-` prefix hardens this against cookie fixation
    // (see csrf-cookie.ts). The prefix's own rules — Secure, Path=/, host-only —
    // are exactly the attributes we already set, so the name switch is the only
    // change: `secure` is already tied to production, `path` is '/', and we
    // never attach a Domain.
    res.cookie(csrfCookieName(this.config.get<string>('app.nodeEnv')), token, {
      httpOnly: false, // the SPA must read it to echo in the X-CSRF-Token header
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: CSRF_MAX_AGE,
    });
    return { csrfToken: token };
  }
}
