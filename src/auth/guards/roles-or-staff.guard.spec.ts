import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { RolesOrStaffGuard } from './roles-or-staff.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../decorators/staff-roles.decorator';
import { UserRole } from '../../users/entities/user.entity';
import { UserStaffRole } from '../../users/entities/user-staff-role.entity';

function ctx(user: unknown): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesOrStaffGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let staffRoles: { exists: jest.Mock };
  let guard: RolesOrStaffGuard;

  /** Answer the two metadata reads the guard makes, by key. */
  function requireMetadata(options: {
    roles?: UserRole[];
    staff?: string[];
  }): void {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === ROLES_KEY ? options.roles : options.staff,
    );
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    staffRoles = { exists: jest.fn() };
    guard = new RolesOrStaffGuard(
      reflector as unknown as Reflector,
      staffRoles as unknown as Repository<UserStaffRole>,
    );
  });

  it('allows the route when neither decorator is present', async () => {
    requireMetadata({});
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(true);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });

  it('reads BOTH metadata keys off the handler and the class', async () => {
    requireMetadata({ roles: [UserRole.Admin], staff: ['communities'] });
    await guard.canActivate(ctx({ userId: 'admin-1', role: UserRole.Admin }));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(STAFF_ROLES_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  describe('with only @Roles (identical to RolesGuard)', () => {
    it('allows a caller whose tier is listed', async () => {
      requireMetadata({ roles: [UserRole.Moderator, UserRole.Admin] });
      await expect(
        guard.canActivate(ctx({ userId: 'mod-1', role: UserRole.Moderator })),
      ).resolves.toBe(true);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });

    it('denies a caller whose tier is not listed, without a grant query', async () => {
      requireMetadata({ roles: [UserRole.Admin] });
      await expect(
        guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
      ).resolves.toBe(false);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });

    it('denies an admin left out of the @Roles list, as RolesGuard would', async () => {
      requireMetadata({ roles: [UserRole.Member] });
      await expect(
        guard.canActivate(ctx({ userId: 'admin-1', role: UserRole.Admin })),
      ).resolves.toBe(false);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });
  });

  describe('with @Roles and @StaffRoles together', () => {
    it('allows the tier without touching the repository', async () => {
      requireMetadata({
        roles: [UserRole.Moderator, UserRole.Admin],
        staff: ['directory_moderator'],
      });
      await expect(
        guard.canActivate(ctx({ userId: 'mod-1', role: UserRole.Moderator })),
      ).resolves.toBe(true);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });

    it('short-circuits admins as a superset of every grant', async () => {
      requireMetadata({ roles: [UserRole.Moderator], staff: ['communities'] });
      await expect(
        guard.canActivate(ctx({ userId: 'admin-1', role: UserRole.Admin })),
      ).resolves.toBe(true);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });

    it('allows a plain member holding one of the required grants', async () => {
      requireMetadata({
        roles: [UserRole.Admin],
        staff: ['editorial', 'partnerships'],
      });
      staffRoles.exists.mockResolvedValue(true);
      await expect(
        guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
      ).resolves.toBe(true);
      expect(staffRoles.exists).toHaveBeenCalledWith({
        where: [
          { userId: 'user-1', role: 'editorial' },
          { userId: 'user-1', role: 'partnerships' },
        ],
      });
    });

    it('denies a plain member holding none of them', async () => {
      requireMetadata({ roles: [UserRole.Admin], staff: ['editorial'] });
      staffRoles.exists.mockResolvedValue(false);
      await expect(
        guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
      ).resolves.toBe(false);
    });

    it('denies a grant holder on a method re-closed with an empty @StaffRoles()', async () => {
      // The narrowing idiom: handler-level `@StaffRoles()` + `@Roles(Admin)`.
      requireMetadata({ roles: [UserRole.Admin], staff: [] });
      await expect(
        guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
      ).resolves.toBe(false);
      expect(staffRoles.exists).not.toHaveBeenCalled();
    });
  });

  it('allows a grant holder when only @StaffRoles is present', async () => {
    requireMetadata({ staff: ['resource_curator'] });
    staffRoles.exists.mockResolvedValue(true);
    await expect(
      guard.canActivate(ctx({ userId: 'user-1', role: UserRole.Member })),
    ).resolves.toBe(true);
  });

  it('denies when there is no authenticated user', async () => {
    requireMetadata({ roles: [UserRole.Admin], staff: ['communities'] });
    await expect(guard.canActivate(ctx(undefined))).resolves.toBe(false);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });
});
