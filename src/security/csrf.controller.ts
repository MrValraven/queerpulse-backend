import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';

// Outlive the 30d refresh token, so the CSRF cookie is never the reason a
// still-authenticated session starts failing. Previously this was a session
// cookie while the auth cookies persisted: after a browser restart the user was
// still logged in but had no CSRF cookie, so their first mutation 403'd until
// the SPA re-fetched a token.
const CSRF_MAX_AGE = 31 * 24 * 60 * 60 * 1000; // 31d

@Public()
@LockdownExempt()
@Controller('csrf-token')
export class CsrfController {
  constructor(private readonly config: ConfigService) {}

  // GET is a safe method, so CsrfGuard lets it through; @Public skips JwtAuthGuard.
  @Get()
  issue(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
      httpOnly: false, // the SPA must read it to echo in the X-CSRF-Token header
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: CSRF_MAX_AGE,
    });
    return { csrfToken: token };
  }
}
