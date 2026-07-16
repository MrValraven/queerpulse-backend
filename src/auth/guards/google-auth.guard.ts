import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { setOAuthStateCookie } from '../auth-cookies';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { OAuthProfileError } from '../errors/oauth-profile.error';
import { encodeOAuthState } from '../oauth-state';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext): { state?: string } {
    const req = context.switchToHttp().getRequest<Request>();

    // Two legs share this guard: the outbound `/auth/google` (no `state` yet) and
    // the inbound `/auth/google/callback` (Google echoes `state` back in the
    // query). Only mint a fresh nonce + cookie on the outbound leg — on the
    // callback passport reads `state` from the query, and re-setting the cookie
    // here would clobber the nonce we need to compare against.
    if (typeof req.query?.state === 'string') {
      return {};
    }

    const res = context.switchToHttp().getResponse<Response>();
    const invite =
      typeof req.query?.invite === 'string' ? req.query.invite : undefined;
    const redirect =
      typeof req.query?.redirect === 'string' ? req.query.redirect : undefined;

    // Bind this authorization request to the browser: a random nonce lives in
    // BOTH a short-lived httpOnly cookie and the OAuth `state` param; the
    // callback rejects unless they match. Defeats login CSRF / session fixation.
    const nonce = randomBytes(32).toString('hex');
    setOAuthStateCookie(res, nonce, {
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      domain: this.config.get<string>('auth.cookieDomain') || undefined,
    });

    // Carry invite + post-login redirect across the consent hop too (both are
    // independently re-validated on the way back).
    const state = encodeOAuthState({ invite, redirect, nonce });
    return state ? { state } : {};
  }

  // Convert OAuth/profile failures into a redirectable error instead of the
  // default 401 JSON. `OAuthCallbackFilter` (bound on the callback route) turns
  // this into a redirect to the SPA sign-in page with `?error=<code>`.
  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err instanceof OAuthProfileError) {
      throw new OAuthCallbackError(err.reason);
    }
    if (err || !user) {
      // Prefer Google's own error code (e.g. `access_denied` when the user
      // declines consent) when it round-tripped in the query.
      const req = context.switchToHttp().getRequest<Request>();
      const code =
        typeof req.query?.error === 'string' ? req.query.error : 'oauth_failed';
      throw new OAuthCallbackError(code);
    }
    return user;
  }
}
