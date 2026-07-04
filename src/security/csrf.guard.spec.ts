import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator';

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
    guard = new CsrfGuard(reflector as unknown as Reflector);
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
