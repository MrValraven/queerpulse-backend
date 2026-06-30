import { CookieOptions, Response } from 'express';

const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15m
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30d

export interface AuthCookieOpts {
  secure: boolean;
  domain?: string;
}

function base(opts: AuthCookieOpts): CookieOptions {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  opts: AuthCookieOpts,
): void {
  res.cookie('access_token', tokens.accessToken, {
    ...base(opts),
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie('refresh_token', tokens.refreshToken, {
    ...base(opts),
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearAuthCookies(res: Response, opts: AuthCookieOpts): void {
  res.clearCookie('access_token', base(opts));
  res.clearCookie('refresh_token', base(opts));
}
