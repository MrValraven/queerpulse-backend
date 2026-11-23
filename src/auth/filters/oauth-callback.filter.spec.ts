import { ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthCallbackFilter } from './oauth-callback.filter';
import { OAuthCallbackError } from '../errors/oauth-callback.error';
import { encodeOAuthState } from '../oauth-state';

function hostFor(
  redirect: jest.Mock<void, [string]>,
  query: Record<string, unknown> = {},
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ redirect }),
      getRequest: () => ({ query }),
    }),
  } as unknown as ArgumentsHost;
}

function makeFilter(): OAuthCallbackFilter {
  const config = {
    getOrThrow: jest.fn().mockReturnValue('https://app.example.com'),
  };
  return new OAuthCallbackFilter(config as unknown as ConfigService);
}

describe('OAuthCallbackFilter', () => {
  it('redirects an OAuth failure to the frontend login with the error code', () => {
    const redirect = jest.fn<void, [string]>();

    makeFilter().catch(
      new OAuthCallbackError('access_denied'),
      hostFor(redirect),
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/auth/sign-in?error=access_denied',
    );
  });

  it('sends a cancelled step-up reauth back to the page it started on (PRD-502)', () => {
    const redirect = jest.fn<void, [string]>();
    const state = encodeOAuthState({
      nonce: 'n-1',
      redirect: '/settings/data/export',
      reauth: true,
    });

    makeFilter().catch(
      new OAuthCallbackError('access_denied'),
      hostFor(redirect, { state, error: 'access_denied' }),
    );

    const landed = new URL(redirect.mock.calls[0]![0]);
    expect(landed.origin + landed.pathname).toBe(
      'https://app.example.com/settings/data/export',
    );
    expect(new URLSearchParams(landed.hash.slice(1)).get('reauthError')).toBe(
      'access_denied',
    );
  });

  it('keeps a reauth failure on the app origin when the redirect is unsafe', () => {
    const redirect = jest.fn<void, [string]>();
    const state = encodeOAuthState({
      nonce: 'n-1',
      redirect: '//evil.example',
      reauth: true,
    });

    makeFilter().catch(
      new OAuthCallbackError('server_error'),
      hostFor(redirect, { state }),
    );

    const landed = new URL(redirect.mock.calls[0]![0]);
    expect(landed.origin).toBe('https://app.example.com');
    expect(new URLSearchParams(landed.hash.slice(1)).get('reauthError')).toBe(
      'server_error',
    );
  });
});
