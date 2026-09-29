import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminAmbassadorsController } from './admin-ambassadors.controller';
import { AmbassadorsService } from './ambassadors.service';

/**
 * The admin routes carry internal grant and revoke reasons, so the gate is
 * the whole story. These run the real `RolesOrStaffGuard` against the real
 * decorator metadata on this controller: an Admin or a `partnerships` holder
 * passes, and any other member is refused (the guard's `false` is Nest's 403).
 */
describe('AdminAmbassadorsController', () => {
  type HandlerName =
    | 'list'
    | 'getCircleSummary'
    | 'takeStaffSeat'
    | 'grant'
    | 'updateFocusArea'
    | 'revoke';

  const handlerNames: HandlerName[] = [
    'list',
    'getCircleSummary',
    'takeStaffSeat',
    'grant',
    'updateFocusArea',
    'revoke',
  ];

  function buildContext(
    handlerName: HandlerName,
    user: { userId: string; role: UserRole },
  ): ExecutionContext {
    const prototype = AdminAmbassadorsController.prototype as unknown as Record<
      HandlerName,
      () => unknown
    >;
    return {
      getHandler: () => prototype[handlerName],
      getClass: () => AdminAmbassadorsController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  function buildGuard(holdsGrant: boolean) {
    const staffRoles = { exists: jest.fn().mockResolvedValue(holdsGrant) };
    const guard = new RolesOrStaffGuard(
      new Reflector(),
      staffRoles as unknown as Repository<UserStaffRole>,
    );
    return { guard, staffRoles };
  }

  it('runs the active-member guard before the roles-or-staff union', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AdminAmbassadorsController,
    ) as unknown[];

    expect(guards).toEqual([ActiveMemberGuard, RolesOrStaffGuard]);
  });

  it.each(handlerNames)('lets an Admin through %s', async (handlerName) => {
    const { guard, staffRoles } = buildGuard(false);

    await expect(
      guard.canActivate(
        buildContext(handlerName, { userId: 'admin-1', role: UserRole.Admin }),
      ),
    ).resolves.toBe(true);
    expect(staffRoles.exists).not.toHaveBeenCalled();
  });

  it.each(handlerNames)(
    'lets a partnerships holder through %s',
    async (handlerName) => {
      const { guard, staffRoles } = buildGuard(true);

      await expect(
        guard.canActivate(
          buildContext(handlerName, {
            userId: 'staff-1',
            role: UserRole.Member,
          }),
        ),
      ).resolves.toBe(true);
      expect(staffRoles.exists).toHaveBeenCalledWith({
        where: [{ userId: 'staff-1', role: 'partnerships' }],
      });
    },
  );

  it.each(handlerNames)('refuses a plain member on %s', async (handlerName) => {
    const { guard } = buildGuard(false);

    await expect(
      guard.canActivate(
        buildContext(handlerName, {
          userId: 'member-1',
          role: UserRole.Member,
        }),
      ),
    ).resolves.toBe(false);
  });

  it('refuses a moderator without the grant', async () => {
    const { guard } = buildGuard(false);

    await expect(
      guard.canActivate(
        buildContext('grant', { userId: 'mod-1', role: UserRole.Moderator }),
      ),
    ).resolves.toBe(false);
  });

  it('reads the list status off the query and defaults to active', async () => {
    const ambassadorsService = { list: jest.fn().mockResolvedValue([]) };
    const controller = new AdminAmbassadorsController(
      ambassadorsService as unknown as AmbassadorsService,
    );

    await controller.list({});
    await controller.list({ status: 'past' });

    expect(ambassadorsService.list).toHaveBeenNthCalledWith(1, 'active');
    expect(ambassadorsService.list).toHaveBeenNthCalledWith(2, 'past');
  });
});
