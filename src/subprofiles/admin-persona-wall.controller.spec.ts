import { ExecutionContext, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminPersonaWallController } from './admin-persona-wall.controller';
import { PersonaWallPick } from './entities/persona-wall-pick.entity';
import { PersonaWallSettings } from './entities/persona-wall-settings.entity';
import { PersonaWallService } from './persona-wall.service';
import { SubprofilesModule } from './subprofiles.module';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PICK_ID = '22222222-2222-4222-8222-222222222222';
const PERSONA_ID = '33333333-3333-4333-8333-333333333333';

const HANDLER_NAMES = [
  'getWall',
  'searchPersonas',
  'addPick',
  'reorderPicks',
  'removePick',
  'updateSettings',
] as const;

type HandlerName = (typeof HANDLER_NAMES)[number];

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    AdminPersonaWallController.prototype as unknown as Record<
      string,
      HandlerFunction | undefined
    >
  )[handlerName];
  if (!handler) {
    throw new Error(`No handler named ${handlerName} on the controller`);
  }
  return handler;
};

const pathOf = (handlerName: HandlerName): string =>
  Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName)) as string;

const methodOf = (handlerName: HandlerName): RequestMethod =>
  Reflect.getMetadata(METHOD_METADATA, handlerOf(handlerName)) as RequestMethod;

describe('AdminPersonaWallController access', () => {
  const reflector = new Reflector();

  it('gates the class to Admin with the staff grant axis switched off', () => {
    expect(reflector.get(ROLES_KEY, AdminPersonaWallController)).toEqual([
      UserRole.Admin,
    ]);
    expect(reflector.get(STAFF_ROLES_KEY, AdminPersonaWallController)).toEqual(
      [],
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminPersonaWallController),
    ).toEqual([ActiveMemberGuard, RolesOrStaffGuard]);
  });

  it.each(HANDLER_NAMES)(
    '%s adds no handler-level role or grant that could reopen the class gate',
    (handlerName) => {
      expect(reflector.get(ROLES_KEY, handlerOf(handlerName))).toBeUndefined();
      expect(
        reflector.get(STAFF_ROLES_KEY, handlerOf(handlerName)),
      ).toBeUndefined();
    },
  );

  it.each([
    [UserRole.Admin, false, true],
    [UserRole.Moderator, false, false],
    // A plain member holding a staff grant.
    [UserRole.Member, true, false],
  ])(
    'RolesOrStaffGuard lets role %s (grant held: %s) through: %s',
    async (role, hasGrant, isAllowed) => {
      const guard = new RolesOrStaffGuard(new Reflector(), {
        exists: jest.fn().mockResolvedValue(hasGrant),
      } as unknown as Repository<UserStaffRole>);
      const context = {
        getHandler: () => handlerOf('addPick'),
        getClass: () => AdminPersonaWallController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: ADMIN_ID, role } }),
        }),
      } as unknown as ExecutionContext;

      expect(await guard.canActivate(context)).toBe(isAllowed);
    },
  );

  it('never looks up a staff grant for a Moderator or a grant holder', async () => {
    const exists = jest.fn().mockResolvedValue(true);
    const guard = new RolesOrStaffGuard(new Reflector(), {
      exists,
    } as unknown as Repository<UserStaffRole>);
    const context = {
      getHandler: () => handlerOf('removePick'),
      getClass: () => AdminPersonaWallController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: ADMIN_ID, role: UserRole.Moderator },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(await guard.canActivate(context)).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('AdminPersonaWallController routes', () => {
  it('serves admin/personas/wall', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPersonaWallController)).toBe(
      'admin/personas/wall',
    );
  });

  it('maps each handler to its verb and path', () => {
    expect(methodOf('getWall')).toBe(RequestMethod.GET);
    expect(pathOf('getWall')).toBe('/');
    expect(methodOf('searchPersonas')).toBe(RequestMethod.GET);
    expect(pathOf('searchPersonas')).toBe('search');
    expect(methodOf('addPick')).toBe(RequestMethod.POST);
    expect(pathOf('addPick')).toBe('picks');
    expect(methodOf('reorderPicks')).toBe(RequestMethod.PATCH);
    expect(pathOf('reorderPicks')).toBe('picks/reorder');
    expect(methodOf('removePick')).toBe(RequestMethod.DELETE);
    expect(pathOf('removePick')).toBe('picks/:id');
    expect(methodOf('updateSettings')).toBe(RequestMethod.PATCH);
    expect(pathOf('updateSettings')).toBe('settings');
  });

  it('registers the controller, the service and both entities in SubprofilesModule', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      SubprofilesModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      'providers',
      SubprofilesModule,
    ) as unknown[];
    const importedModules = Reflect.getMetadata(
      'imports',
      SubprofilesModule,
    ) as { providers?: { provide?: unknown }[] }[];
    const entityTokens = importedModules.flatMap((importedModule) =>
      (importedModule.providers ?? []).map((provider) => provider.provide),
    );

    expect(controllers).toContain(AdminPersonaWallController);
    expect(providers).toContain(PersonaWallService);
    expect(entityTokens).toContain(getRepositoryToken(PersonaWallPick));
    expect(entityTokens).toContain(getRepositoryToken(PersonaWallSettings));
  });
});

describe('AdminPersonaWallController delegation', () => {
  const adminView = { fillOrder: 'endorsed', picks: [], preview: [] };
  let service: {
    adminView: jest.Mock;
    searchPersonas: jest.Mock;
    addPick: jest.Mock;
    reorderPicks: jest.Mock;
    removePick: jest.Mock;
    updateSettings: jest.Mock;
  };
  let controller: AdminPersonaWallController;

  beforeEach(() => {
    service = {
      adminView: jest.fn().mockResolvedValue(adminView),
      searchPersonas: jest.fn().mockResolvedValue({ items: [] }),
      addPick: jest.fn().mockResolvedValue(adminView),
      reorderPicks: jest.fn().mockResolvedValue(adminView),
      removePick: jest.fn().mockResolvedValue(adminView),
      updateSettings: jest.fn().mockResolvedValue(adminView),
    };
    controller = new AdminPersonaWallController(
      service as unknown as PersonaWallService,
    );
  });

  it('loads the admin view', async () => {
    await expect(controller.getWall()).resolves.toBe(adminView);
    expect(service.adminView).toHaveBeenCalledTimes(1);
  });

  it('passes the search text through', async () => {
    const searchResult = { items: [{ isPicked: false }] };
    service.searchPersonas.mockResolvedValue(searchResult);

    const result = await controller.searchPersonas({ q: 'ana' });

    expect(service.searchPersonas).toHaveBeenCalledWith('ana');
    expect(result).toBe(searchResult);
  });

  it('passes the admin id and subprofileId through on add', async () => {
    const result = await controller.addPick(
      { userId: ADMIN_ID } as CurrentUserData,
      { subprofileId: PERSONA_ID },
    );

    expect(service.addPick).toHaveBeenCalledWith(ADMIN_ID, PERSONA_ID);
    expect(result).toBe(adminView);
  });

  it('passes ids through on reorder', async () => {
    const ids = [PICK_ID, PERSONA_ID];

    const result = await controller.reorderPicks({ ids });

    expect(service.reorderPicks).toHaveBeenCalledWith(ids);
    expect(result).toBe(adminView);
  });

  it('passes the pick id through on remove', async () => {
    const result = await controller.removePick(PICK_ID);

    expect(service.removePick).toHaveBeenCalledWith(PICK_ID);
    expect(result).toBe(adminView);
  });

  it('passes the admin id and fillOrder through on settings', async () => {
    const result = await controller.updateSettings(
      { userId: ADMIN_ID } as CurrentUserData,
      { fillOrder: 'newest' },
    );

    expect(service.updateSettings).toHaveBeenCalledWith(ADMIN_ID, 'newest');
    expect(result).toBe(adminView);
  });
});
