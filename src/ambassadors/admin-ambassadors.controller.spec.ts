import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
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
    | 'history'
    | 'getCircleSummary'
    | 'takeStaffSeat'
    | 'grant'
    | 'updateFocusArea'
    | 'revoke';

  const handlerNames: HandlerName[] = [
    'list',
    'history',
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

  it('reads the list status and page off the query, defaulting to the first active page', async () => {
    const ambassadorsService = {
      list: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    };
    const controller = new AdminAmbassadorsController(
      ambassadorsService as unknown as AmbassadorsService,
    );

    await controller.list({});
    await controller.list({ status: 'past', page: 3 });

    expect(ambassadorsService.list).toHaveBeenNthCalledWith(1, 'active', 1);
    expect(ambassadorsService.list).toHaveBeenNthCalledWith(2, 'past', 3);
  });

  it('hands the history query userId to the service (ENG-458)', async () => {
    const ambassadorsService = { historyFor: jest.fn().mockResolvedValue([]) };
    const controller = new AdminAmbassadorsController(
      ambassadorsService as unknown as AmbassadorsService,
    );

    await controller.history({
      userId: '3f0c8d1e-5a4b-4c2d-9e8f-1a2b3c4d5e6f',
    });

    expect(ambassadorsService.historyFor).toHaveBeenCalledWith(
      '3f0c8d1e-5a4b-4c2d-9e8f-1a2b3c4d5e6f',
    );
  });

  it('serves the circle summary through the pure read (ENG-459)', async () => {
    const notFounded = {
      isFounded: false,
      slug: null,
      memberCount: 0,
      isViewerMember: false,
    };
    const ambassadorsService = {
      getCircleSummary: jest.fn().mockResolvedValue(notFounded),
      takeStaffSeat: jest.fn(),
    };
    const controller = new AdminAmbassadorsController(
      ambassadorsService as unknown as AmbassadorsService,
    );

    await expect(
      controller.getCircleSummary({ userId: 'staff-1' } as CurrentUserData),
    ).resolves.toEqual(notFounded);
    expect(ambassadorsService.getCircleSummary).toHaveBeenCalledWith('staff-1');
    expect(ambassadorsService.takeStaffSeat).not.toHaveBeenCalled();
  });
});
