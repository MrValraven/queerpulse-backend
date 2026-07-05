import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthGuard } from './google-auth.guard';
import { decodeOAuthState } from '../oauth-state';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { OAuthProfileError } from '../errors/oauth-profile.error';

function makeGuard(): GoogleAuthGuard {
  // Non-production, no cookie domain.
  const config = { get: jest.fn().mockReturnValue(undefined) };
  return new GoogleAuthGuard(config as unknown as ConfigService);
}

function outboundContext(
  query: Record<string, unknown>,
  res: { cookie: jest.Mock },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query }),
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function callbackContext(query: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ query }) }),
  } as unknown as ExecutionContext;
}

describe('GoogleAuthGuard.getAuthenticateOptions', () => {
  it('mints a nonce cookie and embeds the same nonce in state even with no invite/redirect', () => {
    const res = { cookie: jest.fn() };
    const opts = makeGuard().getAuthenticateOptions(outboundContext({}, res));

    expect(res.cookie).toHaveBeenCalledTimes(1);
    const [name, cookieNonce, cookieOpts] = res.cookie.mock.calls[0];
    expect(name).toBe('oauth_state');
    expect(cookieOpts).toEqual(
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );

    const decoded = decodeOAuthState(opts.state);
    expect(decoded.nonce).toBe(cookieNonce);
    expect(decoded.invite).toBeUndefined();
    expect(decoded.redirect).toBeUndefined();
  });

  it('carries invite + redirect alongside the nonce', () => {
    const res = { cookie: jest.fn() };
    const opts = makeGuard().getAuthenticateOptions(
      outboundContext({ invite: 'CODE', redirect: '/feed' }, res),
    );
    const [, cookieNonce] = res.cookie.mock.calls[0];
    expect(decodeOAuthState(opts.state)).toEqual({
      invite: 'CODE',
      redirect: '/feed',
      nonce: cookieNonce,
    });
  });

  it('ignores non-string query values (keeps only the nonce)', () => {
    const res = { cookie: jest.fn() };
    const opts = makeGuard().getAuthenticateOptions(
      outboundContext({ invite: ['a'], redirect: 5 }, res),
    );
    const decoded = decodeOAuthState(opts.state);
    expect(decoded.invite).toBeUndefined();
    expect(decoded.redirect).toBeUndefined();
    expect(typeof decoded.nonce).toBe('string');
  });

  it('does not re-mint on the callback leg (state already present in query)', () => {
    // On the callback Google echoes `state` back; passport reads it from the
    // query, so we must not overwrite the nonce cookie.
    const guard = makeGuard();
    const opts = guard.getAuthenticateOptions(
      callbackContext({ state: 'abc', code: 'xyz' }),
    );
    expect(opts).toEqual({});
  });
});

describe('GoogleAuthGuard.handleRequest', () => {
  const ctx = (query: Record<string, unknown> = {}): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ query }) }),
    }) as unknown as ExecutionContext;

  it('maps an OAuthProfileError to a redirectable OAuthCallbackError', () => {
    expect(() =>
      makeGuard().handleRequest(
        new OAuthProfileError('email_unverified'),
        null,
        null,
        ctx(),
      ),
    ).toThrow(OAuthCallbackError);
    try {
      makeGuard().handleRequest(
        new OAuthProfileError('no_email'),
        null,
        null,
        ctx(),
      );
    } catch (e) {
      expect((e as OAuthCallbackError).code).toBe('no_email');
    }
  });

  it("uses Google's own error code when the user denies consent", () => {
    try {
      makeGuard().handleRequest(
        null,
        null,
        null,
        ctx({ error: 'access_denied' }),
      );
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthCallbackError);
      expect((e as OAuthCallbackError).code).toBe('access_denied');
    }
  });

  it('falls back to oauth_failed when there is no user and no error code', () => {
    try {
      makeGuard().handleRequest(null, null, null, ctx());
      fail('expected throw');
    } catch (e) {
      expect((e as OAuthCallbackError).code).toBe('oauth_failed');
    }
  });

  it('returns the profile on success', () => {
    const user = { googleId: 'g', email: 'a@b.c' };
    expect(makeGuard().handleRequest(null, user, null, ctx())).toBe(user);
  });
});
