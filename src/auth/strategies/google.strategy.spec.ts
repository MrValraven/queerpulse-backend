import { ConfigService } from '@nestjs/config';
import { Profile } from 'passport-google-oauth20';
import { GoogleStrategy } from './google.strategy';
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
    const err = done.mock.calls[0][0];
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
    const err = done.mock.calls[0][0];
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
    const err = done.mock.calls[0][0];
    expect(err).toBeInstanceOf(OAuthProfileError);
    expect(err.reason).toBe('email_unverified');
  });
});
