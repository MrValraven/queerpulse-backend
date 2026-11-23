import { ConfigService } from '@nestjs/config';
import { Profile } from 'passport-google-oauth20';
import {
  GoogleStrategy,
  googlePkceChallenge,
  googlePkceVerifier,
} from './google.strategy';
import { OAuthProfileError } from '../errors/oauth-profile.error';

function makeStrategy(): GoogleStrategy {
  const config = { getOrThrow: jest.fn().mockReturnValue('x') };
  return new GoogleStrategy(config as unknown as ConfigService);
}

function profile(overrides: Record<string, unknown>): Profile {
  return {
    id: 'g-1',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: 'ada@example.com', verified: true }],
    photos: [{ value: 'https://img/ada.png' }],
    ...overrides,
  } as unknown as Profile;
}

describe('GoogleStrategy.validate', () => {
  it('maps a verified Google profile to GoogleUserInput', () => {
    const done = jest.fn();
    makeStrategy().validate('at', 'rt', profile({}), done);
    expect(done).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        googleId: 'g-1',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        avatarUrl: 'https://img/ada.png',
      }),
    );
  });

  it('rejects a profile with no email (no_email)', () => {
    const done = jest.fn();
    makeStrategy().validate('at', 'rt', profile({ emails: [] }), done);
    const [err] = done.mock.calls[0] as [OAuthProfileError];
    expect(err).toBeInstanceOf(OAuthProfileError);
    expect(err.reason).toBe('no_email');
  });

  it('rejects an unverified email (email_unverified)', () => {
    const done = jest.fn();
    makeStrategy().validate(
      'at',
      'rt',
      profile({ emails: [{ value: 'x@y.com', verified: false }] }),
      done,
    );
    const [err] = done.mock.calls[0] as [OAuthProfileError];
    expect(err).toBeInstanceOf(OAuthProfileError);
    expect(err.reason).toBe('email_unverified');
  });

  it('rejects when the verified flag is merely truthy but not === true', () => {
    const done = jest.fn();
    makeStrategy().validate(
      'at',
      'rt',
      // Google may in theory hand back a string; we require a strict boolean true.
      profile({ emails: [{ value: 'x@y.com', verified: 'true' }] }),
      done,
    );
    const [err] = done.mock.calls[0] as [OAuthProfileError];
    expect(err).toBeInstanceOf(OAuthProfileError);
    expect(err.reason).toBe('email_unverified');
  });
});

describe('GoogleStrategy PKCE (SEC-15)', () => {
  it('derives a 43-character base64url verifier that changes with the nonce', () => {
    const verifier = googlePkceVerifier('secret', 'nonce-1');

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(googlePkceVerifier('secret', 'nonce-2')).not.toBe(verifier);
    expect(googlePkceVerifier('other-secret', 'nonce-1')).not.toBe(verifier);
  });

  it('matches the RFC 7636 appendix B S256 example', () => {
    expect(
      googlePkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('adds the S256 challenge to the consent redirect when the guard passes a nonce', () => {
    const params = makeStrategy().authorizationParams({
      pkceNonce: 'nonce-1',
    });

    expect(params).toEqual(
      expect.objectContaining({
        code_challenge: googlePkceChallenge(googlePkceVerifier('x', 'nonce-1')),
        code_challenge_method: 'S256',
      }),
    );
  });

  it('sends the matching verifier with the code exchange', () => {
    expect(makeStrategy().tokenParams({ pkceNonce: 'nonce-1' })).toEqual(
      expect.objectContaining({
        code_verifier: googlePkceVerifier('x', 'nonce-1'),
      }),
    );
  });

  it('sends no verifier when the nonce cookie is missing', () => {
    expect(makeStrategy().tokenParams({})).not.toHaveProperty('code_verifier');
    expect(makeStrategy().authorizationParams({})).not.toHaveProperty(
      'code_challenge',
    );
  });
});
