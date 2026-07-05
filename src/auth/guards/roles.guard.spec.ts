import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../../users/entities/user.entity';

function ctx(user: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows the route when no roles are required', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(ctx({ role: UserRole.Member }))).toBe(true);
  });

  it('allows the route when the required list is empty', () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(ctx({ role: UserRole.Member }))).toBe(true);
  });

  it('allows when the user holds one of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([
      UserRole.Admin,
      UserRole.Moderator,
    ]);
    expect(guard.canActivate(ctx({ role: UserRole.Moderator }))).toBe(true);
  });

  it('rejects when the user lacks every required role', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.Admin]);
    expect(guard.canActivate(ctx({ role: UserRole.Member }))).toBe(false);
  });

  it('rejects when there is no authenticated user', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.Admin]);
    expect(guard.canActivate(ctx(undefined))).toBe(false);
  });
});
