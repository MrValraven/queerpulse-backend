import { CookieOptions, Response } from 'express';

const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15m
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30d
// The OAuth `state` nonce only needs to survive the Google consent round-trip.
const OAUTH_STATE_MAX_AGE = 10 * 60 * 1000; // 10m

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

/**
 * Set the short-lived, httpOnly `oauth_state` nonce cookie. Same flags as the
 * auth cookies (httpOnly + SameSite=Lax so it survives the top-level redirect
 * back from Google) plus a tight max-age.
 */
export function setOAuthStateCookie(
  res: Response,
  nonce: string,
  opts: AuthCookieOpts,
): void {
  res.cookie('oauth_state', nonce, {
    ...base(opts),
    maxAge: OAUTH_STATE_MAX_AGE,
  });
}

/** Clear the one-time `oauth_state` nonce cookie. */
export function clearOAuthStateCookie(res: Response, opts: AuthCookieOpts): void {
  res.clearCookie('oauth_state', base(opts));
}

/**
 * Clear the CSRF double-submit cookie. It is set host-only (no domain) with
 * `path: '/'` by CsrfController, so we clear it with a matching path and no
 * domain regardless of the auth-cookie domain.
 */
export function clearCsrfCookie(res: Response): void {
  res.clearCookie('csrf_token', { path: '/' });
}
