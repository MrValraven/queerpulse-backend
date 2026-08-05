import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { StaffRolesGuard } from './staff-roles.guard';
import { UserRole } from '../../users/entities/user.entity';
import { UserStaffRole } from '../../users/entities/user-staff-role.entity';

function ctx(user: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('StaffRolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let staffRoles: { exists: jest.Mock };
  let guard: StaffRolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    staffRoles = { exists: jest.fn() };
    guard = new StaffRolesGuard(
      reflector as unknown as Reflector,
      staffRoles as unknown as Repository<UserStaffRole>,
    );
  });

  it('allows the route when no staff roles are required (no metadata)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(true);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });

  it('allows the route when the required list is empty', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(true);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });

  it('short-circuits admins as allowed without touching the repository', async () => {
    reflector.getAllAndOverride.mockReturnValue(['magazine_editor']);
    await expect(
      guard.canActivate(ctx({ userId: 'admin-1', role: UserRole.Admin })),
    ).resolves.toBe(true);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });

  it('allows a member holding one of the required grants', async () => {
    reflector.getAllAndOverride.mockReturnValue(['magazine_editor']);
    staffRoles.exists.mockResolvedValue(true);
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(true);
    expect(staffRoles.exists).toHaveBeenCalledWith({
      where: [{ userId: 'user-1', role: 'magazine_editor' }],
    });
  });

  it('denies a member lacking every required grant', async () => {
    reflector.getAllAndOverride.mockReturnValue(['magazine_editor']);
    staffRoles.exists.mockResolvedValue(false);
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(false);
  });

  it('denies when there is no authenticated user', async () => {
    reflector.getAllAndOverride.mockReturnValue(['magazine_editor']);
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(false);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });
});
