import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ActiveMemberGuard } from './active-member.guard';
import { UserStatus } from '../../users/entities/user.entity';

function ctx(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('ActiveMemberGuard', () => {
  const guard = new ActiveMemberGuard();

  it('allows an active member', () => {
    expect(guard.canActivate(ctx({ status: UserStatus.Active }))).toBe(true);
  });

  it('rejects a deactivated member', () => {
    expect(() =>
      guard.canActivate(ctx({ status: UserStatus.Deactivated })),
    ).toThrow(ForbiddenException);
  });

  it('rejects a suspended member', () => {
    expect(() =>
      guard.canActivate(ctx({ status: UserStatus.Suspended })),
    ).toThrow(ForbiddenException);
  });

  it('rejects when there is no authenticated user', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
