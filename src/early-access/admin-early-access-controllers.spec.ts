import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminEarlyAccessController } from './admin-early-access.controller';
import { AdminMemberEarlyAccessController } from './admin-member-early-access.controller';
import { EarlyAccessAdminService } from './early-access-admin.service';
import { EarlyAccessModule } from './early-access.module';

const MEMBER_ID = '7c000000-0000-4000-8000-000000000002';

const adminControllers = [
  AdminMemberEarlyAccessController,
  AdminEarlyAccessController,
];

const handlerOf = (
  controller: { prototype: unknown },
  methodName: string,
): object => {
  const handler = (controller.prototype as Record<string, object | undefined>)[
    methodName
  ];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

describe('Admin early access controllers', () => {
  it('registers both controllers and the service in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, EarlyAccessModule),
    ).toEqual(expect.arrayContaining(adminControllers));
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EarlyAccessModule),
    ).toEqual(expect.arrayContaining([EarlyAccessAdminService]));
  });

  it.each(adminControllers.map((controller) => [controller.name, controller]))(
    'opens %s to moderators and admins only',
    (_name, controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        ActiveMemberGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual([
        UserRole.Moderator,
        UserRole.Admin,
      ]);
    },
  );

  it('narrows the grant to admins while view and revoke inherit moderator and admin', () => {
    // `RolesGuard` resolves roles with `getAllAndOverride([handler, class])`,
    // so the grant handler's own `[Admin]` wins over the class roles and the
    // untagged handlers fall back to them.
    const reflector = new Reflector();
    const effectiveRoles = (
      controller: { prototype: unknown },
      methodName: string,
    ): UserRole[] | undefined =>
      reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
        handlerOf(controller, methodName) as () => unknown,
        controller as unknown as new () => unknown,
      ]);

    expect(effectiveRoles(AdminMemberEarlyAccessController, 'grant')).toEqual([
      UserRole.Admin,
    ]);
    const moderatorAndAdminRoutes = [
      [AdminMemberEarlyAccessController, 'listForMember'],
      [AdminMemberEarlyAccessController, 'revoke'],
      [AdminEarlyAccessController, 'listFeatures'],
      [AdminEarlyAccessController, 'roster'],
    ] as const;
    for (const [controller, methodName] of moderatorAndAdminRoutes) {
      expect(effectiveRoles(controller, methodName)).toEqual([
        UserRole.Moderator,
        UserRole.Admin,
      ]);
    }
  });

  it.each(adminControllers.map((controller) => [controller.name, controller]))(
    'leaves %s untagged so it stays reachable while the feature is hidden',
    (_name, controller) => {
      expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBeUndefined();
    },
  );

  it('serves the member drawer routes under admin/members', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminMemberEarlyAccessController),
    ).toBe('admin/members');
    const routes = [
      ['listForMember', RequestMethod.GET, ':id/early-access'],
      ['grant', RequestMethod.PUT, ':id/early-access/:feature'],
      ['revoke', RequestMethod.DELETE, ':id/early-access/:feature'],
    ] as const;
    for (const [methodName, requestMethod, routePath] of routes) {
      const handler = handlerOf(AdminMemberEarlyAccessController, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(requestMethod);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(routePath);
    }
  });

  it('answers 200 to the grant and 204 to the revoke', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(AdminMemberEarlyAccessController, 'grant'),
      ),
    ).toBe(200);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(AdminMemberEarlyAccessController, 'revoke'),
      ),
    ).toBe(204);
  });

  it('serves the roster page routes under admin/early-access', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminEarlyAccessController)).toBe(
      'admin/early-access',
    );
    const routes = [
      ['listFeatures', '/'],
      ['roster', ':feature'],
    ] as const;
    for (const [methodName, routePath] of routes) {
      const handler = handlerOf(AdminEarlyAccessController, methodName);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.GET,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(routePath);
    }
  });

  it('passes the acting staff member, the member and the raw feature key to the service', async () => {
    const earlyAccess = {
      listForMember: jest.fn().mockResolvedValue({ features: [] }),
      grant: jest.fn().mockResolvedValue({ featureKey: 'quizshow' }),
      revoke: jest.fn().mockResolvedValue(undefined),
      listFeatures: jest.fn().mockResolvedValue({ features: [] }),
      roster: jest.fn().mockResolvedValue({ featureKey: 'quizshow' }),
    };
    const service = earlyAccess as unknown as EarlyAccessAdminService;
    const staffUser = { userId: 'staff-1' } as CurrentUserData;
    const memberController = new AdminMemberEarlyAccessController(service);
    const rosterController = new AdminEarlyAccessController(service);

    await memberController.listForMember(MEMBER_ID);
    await memberController.grant(staffUser, MEMBER_ID, 'quizshow');
    await memberController.revoke(staffUser, MEMBER_ID, 'quizshow');
    await rosterController.listFeatures();
    await rosterController.roster('quizshow');

    expect(earlyAccess.listForMember).toHaveBeenCalledWith(MEMBER_ID);
    expect(earlyAccess.grant).toHaveBeenCalledWith(
      'staff-1',
      MEMBER_ID,
      'quizshow',
    );
    expect(earlyAccess.revoke).toHaveBeenCalledWith(
      'staff-1',
      MEMBER_ID,
      'quizshow',
    );
    expect(earlyAccess.listFeatures).toHaveBeenCalledTimes(1);
    expect(earlyAccess.roster).toHaveBeenCalledWith('quizshow');
  });
});
