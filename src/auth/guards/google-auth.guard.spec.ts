import { ExecutionContext } from '@nestjs/common';
import { GoogleAuthGuard } from './google-auth.guard';
import { decodeOAuthState } from '../oauth-state';

function contextWithQuery(query: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query }),
    }),
  } as unknown as ExecutionContext;
}

describe('GoogleAuthGuard.getAuthenticateOptions', () => {
  const guard = new GoogleAuthGuard();

  it('returns no state when neither invite nor redirect is present', () => {
    expect(guard.getAuthenticateOptions(contextWithQuery({}))).toEqual({});
  });

  it('encodes the invite code into state', () => {
    const opts = guard.getAuthenticateOptions(
      contextWithQuery({ invite: 'CODE' }),
    );
    expect(decodeOAuthState(opts.state)).toEqual({
      invite: 'CODE',
    });
  });

  it('encodes the redirect path into state', () => {
    const opts = guard.getAuthenticateOptions(
      contextWithQuery({ redirect: '/feed' }),
    );
    expect(decodeOAuthState(opts.state)).toEqual({
      redirect: '/feed',
    });
  });

  it('encodes both invite and redirect together', () => {
    const opts = guard.getAuthenticateOptions(
      contextWithQuery({ invite: 'CODE', redirect: '/auth/welcome' }),
    );
    expect(decodeOAuthState(opts.state)).toEqual({
      invite: 'CODE',
      redirect: '/auth/welcome',
    });
  });

  it('ignores non-string query values', () => {
    const opts = guard.getAuthenticateOptions(
      contextWithQuery({ invite: ['a'], redirect: 5 }),
    );
    expect(opts).toEqual({});
  });
});
