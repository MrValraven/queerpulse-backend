import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { createHash, createHmac } from 'node:crypto';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { GoogleUserInput } from '../auth.service';
import { OAuthProfileError } from '../errors/oauth-profile.error';

/**
 * The authenticate options `GoogleAuthGuard` adds for PKCE (SEC-15, RFC 7636).
 * `pkceNonce` is the `oauth_state` nonce: minted on the outbound leg, read back
 * from the httpOnly cookie on the callback leg.
 */
export interface GooglePkceOptions {
  pkceNonce?: string;
}

/**
 * The PKCE code verifier for one sign-in attempt, derived from the attempt's
 * `oauth_state` nonce. The nonce also travels inside the public `state`
 * parameter, so the verifier is an HMAC of it under the client secret: anyone
 * who reads the URL learns the nonce and still cannot compute the verifier. A
 * code stolen from another browser fails the token exchange, because this
 * browser's cookie holds a different nonce. 43 base64url characters, the
 * minimum length RFC 7636 allows.
 */
export function googlePkceVerifier(
  clientSecret: string,
  nonce: string,
): string {
  return createHmac('sha256', clientSecret)
    .update(`google-pkce:${nonce}`)
    .digest('base64url');
}

/** The S256 challenge for a verifier (RFC 7636 section 4.2). */
export function googlePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly pkceSecret: string;

  constructor(config: ConfigService) {
    const clientSecret = config.getOrThrow<string>('auth.googleClientSecret');
    super({
      clientID: config.getOrThrow<string>('auth.googleClientId'),
      clientSecret,
      callbackURL: config.getOrThrow<string>('auth.googleCallbackUrl'),
      scope: ['email', 'profile'],
    });
    this.pkceSecret = clientSecret;
  }

  /**
   * Adds the PKCE challenge to the consent redirect. The nonce state stays in
   * the one `oauth_state` cookie the guard already sets, so PKCE needs no
   * session store and no second cookie.
   */
  authorizationParams(options: GooglePkceOptions): object {
    const params: Record<string, unknown> = {
      ...super.authorizationParams(options),
    };
    if (options.pkceNonce) {
      params.code_challenge = googlePkceChallenge(
        googlePkceVerifier(this.pkceSecret, options.pkceNonce),
      );
      params.code_challenge_method = 'S256';
    }
    return params;
  }

  /**
   * Sends the verifier with the code exchange. Without a nonce cookie the
   * exchange goes out with no verifier and Google refuses it, which
   * `GoogleAuthGuard.handleRequest` reports as `invalid_state`.
   */
  tokenParams(options: GooglePkceOptions): object {
    const params: Record<string, unknown> = {
      ...super.tokenParams(options),
    };
    if (options.pkceNonce) {
      params.code_verifier = googlePkceVerifier(
        this.pkceSecret,
        options.pkceNonce,
      );
    }
    return params;
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const { id, name, emails, photos } = profile;
    const primary = emails?.[0];
    const email = primary?.value;
    if (!email) {
      // No email on the Google account — mapped to `?error=no_email` upstream.
      done(new OAuthProfileError('no_email'), undefined);
      return;
    }
    if (primary?.verified !== true) {
      // Never trust an unverified Google email (account-takeover vector) —
      // mapped to `?error=email_unverified` upstream.
      done(new OAuthProfileError('email_unverified'), undefined);
      return;
    }
    const result: GoogleUserInput = {
      googleId: id,
      email,
      firstName: name?.givenName ?? email.split('@')[0] ?? email,
      lastName: name?.familyName ?? '',
      avatarUrl: photos?.[0]?.value ?? null,
    };
    done(null, result);
  }
}
