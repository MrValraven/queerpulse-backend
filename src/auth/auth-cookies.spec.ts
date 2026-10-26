import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  EMAIL_CODE_REQUESTER_COOKIE,
  EMAIL_CODE_REQUESTER_MAX_AGE_MS,
  sessionCookieOptsFromConfig,
  setEmailCodeRequesterCookie,
} from './auth-cookies';

describe('auth-cookies', () => {
  it('setEmailCodeRequesterCookie sets an httpOnly lax cookie scoped to /auth for 30 days', () => {
    const cookie = jest.fn();
    const res = { cookie } as unknown as Response;
    setEmailCodeRequesterCookie(res, 'v', {
      secure: true,
      domain: '.queerpulse.com',
    });
    expect(EMAIL_CODE_REQUESTER_COOKIE).toBe('email_code_requester');
    expect(EMAIL_CODE_REQUESTER_MAX_AGE_MS).toBe(2_592_000_000);
    expect(cookie).toHaveBeenCalledWith('email_code_requester', 'v', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth',
      domain: '.queerpulse.com',
      maxAge: 2_592_000_000,
    });
  });

  it('sessionCookieOptsFromConfig reads secure, domain and both TTLs', () => {
    const values: Record<string, unknown> = {
      'app.nodeEnv': 'production',
      'auth.cookieDomain': '.queerpulse.com',
      'auth.jwtAccessTtlMs': 900_000,
      'auth.jwtRefreshTtlMs': 2_592_000_000,
    };
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService;
    expect(sessionCookieOptsFromConfig(config)).toEqual({
      secure: true,
      domain: '.queerpulse.com',
      accessMaxAge: 900_000,
      refreshMaxAge: 2_592_000_000,
    });
  });
});
