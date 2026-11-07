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

  it('ships the ACTIVE_MEMBERSHIP_REQUIRED code beside the unchanged sentence', () => {
    let refusal: ForbiddenException | undefined;
    try {
      guard.canActivate(ctx({ status: UserStatus.Suspended }));
    } catch (error) {
      refusal = error as ForbiddenException;
    }
    expect(refusal?.getResponse()).toEqual({
      code: 'ACTIVE_MEMBERSHIP_REQUIRED',
      message: 'Active membership required',
    });
    expect(refusal?.message).toBe('Active membership required');
  });
});
