import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  NotRestrictedGuard,
  ACCOUNT_RESTRICTED_CODE,
} from './not-restricted.guard';

function ctx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('NotRestrictedGuard', () => {
  const guard = new NotRestrictedGuard();

  it('allows a member with no restriction', () => {
    expect(guard.canActivate(ctx({ restricted: false }))).toBe(true);
  });

  it('allows a member whose CurrentUserData carries no restriction field at all', () => {
    // `restricted` is optional on `CurrentUserData` (older fixtures, unit
    // tests) — undefined must read the same as `false`, not throw.
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it('rejects a restricted member with the typed code', () => {
    expect(() => guard.canActivate(ctx({ restricted: true }))).toThrow(
      ForbiddenException,
    );
    try {
      guard.canActivate(ctx({ restricted: true }));
      fail('expected canActivate to throw');
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: ACCOUNT_RESTRICTED_CODE,
      });
    }
  });

  it('allows when there is no authenticated user (an earlier guard already rejects it)', () => {
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });
});
