import { ExecutionContext, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminDirectoryPartnersController } from './admin-directory-partners.controller';
import { AdminListingsController } from './admin-listings.controller';
import { DirectoryPartnersService } from './directory-partners.service';
import { ListingsModule } from './listings.module';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PICK_ID = '22222222-2222-4222-8222-222222222222';

const HANDLER_NAMES = [
  'listPartners',
  'searchListings',
  'addPartner',
  'reorderPartners',
  'updateNote',
  'removePartner',
] as const;

type HandlerName = (typeof HANDLER_NAMES)[number];

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    AdminDirectoryPartnersController.prototype as unknown as Record<
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

describe('AdminDirectoryPartnersController access', () => {
  const reflector = new Reflector();

  it('gates the class to Admin with the staff grant axis switched off', () => {
    expect(reflector.get(ROLES_KEY, AdminDirectoryPartnersController)).toEqual([
      UserRole.Admin,
    ]);
    expect(
      reflector.get(STAFF_ROLES_KEY, AdminDirectoryPartnersController),
    ).toEqual([]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminDirectoryPartnersController),
    ).toEqual([ActiveMemberGuard, RolesOrStaffGuard]);
  });

  it('carries the listings feature flag like AdminListingsController', () => {
    expect(
      reflector.get(FEATURE_KEY, AdminDirectoryPartnersController),
    ).toEqual(reflector.get(FEATURE_KEY, AdminListingsController));
    expect(reflector.get(FEATURE_KEY, AdminDirectoryPartnersController)).toBe(
      'listings',
    );
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
    // A plain member holding the directory_moderator grant.
    [UserRole.Member, true, false],
  ])(
    'RolesOrStaffGuard lets role %s (grant held: %s) through: %s',
    async (role, hasGrant, isAllowed) => {
      const guard = new RolesOrStaffGuard(new Reflector(), {
        exists: jest.fn().mockResolvedValue(hasGrant),
      } as unknown as Repository<UserStaffRole>);
      const context = {
        getHandler: () => handlerOf('addPartner'),
        getClass: () => AdminDirectoryPartnersController,
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
      getHandler: () => handlerOf('removePartner'),
      getClass: () => AdminDirectoryPartnersController,
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

describe('AdminDirectoryPartnersController routes', () => {
  it('serves admin/listings/partners', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminDirectoryPartnersController),
    ).toBe('admin/listings/partners');
  });

  it('maps each handler to its verb and path', () => {
    expect(methodOf('listPartners')).toBe(RequestMethod.GET);
    expect(pathOf('listPartners')).toBe('/');
    expect(methodOf('searchListings')).toBe(RequestMethod.GET);
    expect(pathOf('searchListings')).toBe('search');
    expect(methodOf('addPartner')).toBe(RequestMethod.POST);
    expect(pathOf('addPartner')).toBe('/');
    expect(methodOf('reorderPartners')).toBe(RequestMethod.PATCH);
    expect(pathOf('reorderPartners')).toBe('order');
    expect(methodOf('updateNote')).toBe(RequestMethod.PATCH);
    expect(pathOf('updateNote')).toBe(':id');
    expect(methodOf('removePartner')).toBe(RequestMethod.DELETE);
    expect(pathOf('removePartner')).toBe(':id');
  });

  it('declares the static search and order routes before any :id route', () => {
    const declarationOrder = Object.getOwnPropertyNames(
      AdminDirectoryPartnersController.prototype,
    );
    const firstIdRouteIndex = Math.min(
      declarationOrder.indexOf('updateNote'),
      declarationOrder.indexOf('removePartner'),
    );

    expect(declarationOrder.indexOf('searchListings')).toBeLessThan(
      firstIdRouteIndex,
    );
    expect(declarationOrder.indexOf('reorderPartners')).toBeLessThan(
      firstIdRouteIndex,
    );
  });

  it('is registered ahead of AdminListingsController so its literal segments win', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      ListingsModule,
    ) as unknown[];

    expect(controllers).toContain(AdminDirectoryPartnersController);
    expect(controllers.indexOf(AdminDirectoryPartnersController)).toBeLessThan(
      controllers.indexOf(AdminListingsController),
    );
  });

  it('registers the service as a provider of the module', () => {
    const providers = Reflect.getMetadata(
      'providers',
      ListingsModule,
    ) as unknown[];

    expect(providers).toContain(DirectoryPartnersService);
  });
});

describe('AdminDirectoryPartnersController delegation', () => {
  const partnerList = [{ id: PICK_ID }];
  let service: {
    listPartners: jest.Mock;
    searchListings: jest.Mock;
    addPartner: jest.Mock;
    updateNote: jest.Mock;
    reorderPartners: jest.Mock;
    removePartner: jest.Mock;
  };
  let controller: AdminDirectoryPartnersController;

  beforeEach(() => {
    service = {
      listPartners: jest.fn().mockResolvedValue(partnerList),
      searchListings: jest.fn().mockResolvedValue([]),
      addPartner: jest.fn().mockResolvedValue(partnerList),
      updateNote: jest.fn().mockResolvedValue(partnerList),
      reorderPartners: jest.fn().mockResolvedValue(partnerList),
      removePartner: jest.fn().mockResolvedValue(partnerList),
    };
    controller = new AdminDirectoryPartnersController(
      service as unknown as DirectoryPartnersService,
    );
  });

  it('lists the partners', async () => {
    await expect(controller.listPartners()).resolves.toBe(partnerList);
    expect(service.listPartners).toHaveBeenCalledTimes(1);
  });

  it('passes the search text through', async () => {
    await controller.searchListings({ q: 'casa' });

    expect(service.searchListings).toHaveBeenCalledWith('casa');
  });

  it('passes an absent search text through as undefined', async () => {
    await controller.searchListings({});

    expect(service.searchListings).toHaveBeenCalledWith(undefined);
  });

  it('passes the admin id and body through on add and returns the full list', async () => {
    const body = { listingId: PICK_ID, note: 'Our neighbour' };

    const result = await controller.addPartner(
      { userId: ADMIN_ID } as CurrentUserData,
      body,
    );

    expect(service.addPartner).toHaveBeenCalledWith(ADMIN_ID, body);
    expect(result).toBe(partnerList);
  });

  it('passes the ids through on reorder and returns the full list', async () => {
    const ids = [PICK_ID, ADMIN_ID];

    const result = await controller.reorderPartners({ ids });

    expect(service.reorderPartners).toHaveBeenCalledWith(ids);
    expect(result).toBe(partnerList);
  });

  it('passes the pick id and body through on a note change', async () => {
    const result = await controller.updateNote(PICK_ID, { note: null });

    expect(service.updateNote).toHaveBeenCalledWith(PICK_ID, { note: null });
    expect(result).toBe(partnerList);
  });

  it('passes the pick id through on remove and returns the full list', async () => {
    const result = await controller.removePartner(PICK_ID);

    expect(service.removePartner).toHaveBeenCalledWith(PICK_ID);
    expect(result).toBe(partnerList);
  });
});
