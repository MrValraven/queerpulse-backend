import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { setOAuthStateCookie } from '../auth-cookies';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { OAuthProfileError } from '../errors/oauth-profile.error';
import { encodeOAuthState, sanitizeTermsVersion } from '../oauth-state';

/**
 * The OAuth 2.0 error codes an authorization endpoint may return
 * (RFC 6749 §4.1.2.1), plus Google's `admin_policy_enforced`. Anything outside
 * this set is collapsed to `oauth_failed`.
 *
 * `?error=` is attacker-controllable on a direct hit of the callback URL, and
 * the value is reflected into the sign-in redirect. `signInErrorUrl` puts it
 * through `searchParams.set`, so it is percent-encoded and cannot break out of
 * the query, but an unbounded string still ends up in a URL the SPA cannot map
 * to any copy, in the browser's history, and in our access logs. An allowlist
 * costs nothing and keeps the vocabulary the SPA renders finite.
 */
const GOOGLE_OAUTH_ERROR_CODES = new Set([
  'access_denied',
  'admin_policy_enforced',
  'invalid_request',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'unauthorized_client',
  'unsupported_response_type',
]);

function safeOAuthErrorCode(raw: unknown): string {
  return typeof raw === 'string' && GOOGLE_OAUTH_ERROR_CODES.has(raw)
    ? raw
    : 'oauth_failed';
}

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext): {
    state?: string;
    prompt?: string;
  } {
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
    // 18+ self-attestation, ticked before the client sends us here. Only the
    // literal "1" attests, so a stray `?ageAttested=0` can't sneak through.
    const ageAttested = req.query?.ageAttested === '1';
    // Clamped, not copied verbatim: this ends up in `users.terms_version`
    // (`varchar(32)`), so an over-long value from a crafted link failed the
    // INSERT after Google consent with a raw 500. See `sanitizeTermsVersion`.
    const termsVersion = sanitizeTermsVersion(req.query?.termsVersion);
    // Step-up re-auth (see `OAuthState.reauth`'s doc comment). Only the
    // literal "1" opts in, same guard as `ageAttested`.
    const reauth = req.query?.reauth === '1';

    // Bind this authorization request to the browser: a random nonce lives in
    // BOTH a short-lived httpOnly cookie and the OAuth `state` param; the
    // callback rejects unless they match. Defeats login CSRF / session fixation.
    const nonce = randomBytes(32).toString('hex');
    setOAuthStateCookie(res, nonce, {
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      domain: this.config.get<string>('auth.cookieDomain') || undefined,
    });

    // Carry invite + post-login redirect + the age attestation across the
    // consent hop too (invite and redirect are independently re-validated on the
    // way back; see the integrity note in oauth-state.ts for why the
    // attestation is trusted as-declared).
    const state = encodeOAuthState({
      invite,
      redirect,
      nonce,
      ageAttested,
      termsVersion,
      reauth,
    });
    return {
      ...(state ? { state } : {}),
      // Forces Google to show its login screen even if the browser already
      // has an active Google session — proof the caller can complete a fresh
      // login RIGHT NOW, not just that a cookie is still valid. Only set for
      // the reauth leg; ordinary sign-in never forces re-entry.
      ...(reauth ? { prompt: 'login' } : {}),
    };
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
      // declines consent) when it round-tripped in the query, but only from
      // the known vocabulary — see GOOGLE_OAUTH_ERROR_CODES.
      const req = context.switchToHttp().getRequest<Request>();
      throw new OAuthCallbackError(safeOAuthErrorCode(req.query?.error));
    }
    return user;
  }
}
