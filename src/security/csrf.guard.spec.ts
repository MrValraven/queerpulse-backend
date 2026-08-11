import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CsrfGuard } from './csrf.guard';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';

/** A ConfigService stub whose only key that matters here is `app.nodeEnv`. */
function configFor(nodeEnv: string): { get: jest.Mock } {
  return { get: jest.fn((key: string) => (key === 'app.nodeEnv' ? nodeEnv : undefined)) };
}

function httpContext(
  method: string,
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => ({ method, cookies, headers }) }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: CsrfGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    // Default to non-production, so the guard reads the bare `csrf_token` name
    // the existing cases below use.
    guard = new CsrfGuard(
      reflector as unknown as Reflector,
      configFor('development') as unknown as ConfigService,
    );
  });

  it('allows safe methods without tokens', () => {
    expect(guard.canActivate(httpContext('GET'))).toBe(true);
  });

  it('allows non-http contexts (websocket handshakes)', () => {
    const ctx = {
      getType: () => 'ws',
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects mutating requests without tokens', () => {
    expect(() => guard.canActivate(httpContext('POST'))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects mismatched cookie and header tokens', () => {
    expect(() =>
      guard.canActivate(
        httpContext('POST', { csrf_token: 'aaa' }, { 'x-csrf-token': 'bbb' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows matching cookie and header tokens', () => {
    expect(
      guard.canActivate(
        httpContext(
          'POST',
          { csrf_token: 'match' },
          { 'x-csrf-token': 'match' },
        ),
      ),
    ).toBe(true);
  });

  it('reads the `__Host-`-prefixed cookie in production', () => {
    const prodGuard = new CsrfGuard(
      reflector as unknown as Reflector,
      configFor('production') as unknown as ConfigService,
    );
    // The bare-named cookie must NOT satisfy the check in production — accepting
    // it would reopen the subdomain fixation vector the prefix closes.
    expect(() =>
      prodGuard.canActivate(
        httpContext('POST', { csrf_token: 'x' }, { 'x-csrf-token': 'x' }),
      ),
    ).toThrow(ForbiddenException);
    // The `__Host-` cookie matching the header passes.
    expect(
      prodGuard.canActivate(
        httpContext(
          'POST',
          { '__Host-csrf_token': 'x' },
          { 'x-csrf-token': 'x' },
        ),
      ),
    ).toBe(true);
  });

  it('allows token-less mutating requests on @SkipCsrf routes', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const ctx = httpContext('POST');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });
});
