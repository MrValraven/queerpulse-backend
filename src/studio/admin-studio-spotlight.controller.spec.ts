import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioSpotlightController } from './admin-studio-spotlight.controller';
import { AdminStudioSpotlightService } from './admin-studio-spotlight.service';
import { StudioModule } from './studio.module';

const guardsOf = (controller: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];

const handlerOf = (methodName: string): object => {
  const handler = (
    AdminStudioSpotlightController.prototype as unknown as Record<
      string,
      object | undefined
    >
  )[methodName];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const routePathOf = (methodName: string): unknown =>
  Reflect.getMetadata(PATH_METADATA, handlerOf(methodName));

const routeMethodOf = (methodName: string): unknown =>
  Reflect.getMetadata(METHOD_METADATA, handlerOf(methodName));

const STAFF_USER: CurrentUserData = {
  userId: 'staff-user-id',
} as CurrentUserData;

const SPOTLIGHT_ID = '5b0f64d4-96dd-4c0b-8f1e-0b6a7f4a9e11';

describe('AdminStudioSpotlightController', () => {
  it('guards the controller with ActiveMemberGuard and RolesOrStaffGuard, the moderator and admin tiers and the music_manager_producer grant', () => {
    expect(guardsOf(AdminStudioSpotlightController)).toEqual([
      ActiveMemberGuard,
      RolesOrStaffGuard,
    ]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminStudioSpotlightController),
    ).toEqual([UserRole.Moderator, UserRole.Admin]);
    expect(
      Reflect.getMetadata(STAFF_ROLES_KEY, AdminStudioSpotlightController),
    ).toEqual(['music_manager_producer']);
  });

  it('tags the controller with the studio feature', () => {
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminStudioSpotlightController),
    ).toBe('studio');
  });

  it.each([
    ['getSpotlight', RequestMethod.GET, '/'],
    ['searchArtists', RequestMethod.GET, 'artist-search'],
    ['setArtistOfTheMonth', RequestMethod.PUT, 'artist-of-the-month'],
    ['clearArtistOfTheMonth', RequestMethod.DELETE, 'artist-of-the-month'],
    ['addNewStar', RequestMethod.POST, 'new-stars'],
    ['reorderNewStars', RequestMethod.POST, 'new-stars/reorder'],
    ['updateNote', RequestMethod.PATCH, ':id'],
    ['removeSpotlightArtist', RequestMethod.DELETE, ':id'],
  ])('serves the contract path and method of %s', (name, method, path) => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminStudioSpotlightController),
    ).toBe('admin/studio/spotlight');
    expect(routeMethodOf(name)).toBe(method);
    expect(routePathOf(name)).toBe(path);
  });

  it('declares every literal route ahead of the :id routes', () => {
    const handlerNames = Object.getOwnPropertyNames(
      AdminStudioSpotlightController.prototype,
    );
    const literalHandlers = [
      'getSpotlight',
      'searchArtists',
      'setArtistOfTheMonth',
      'clearArtistOfTheMonth',
      'addNewStar',
      'reorderNewStars',
    ];
    const firstIdRouteIndex = Math.min(
      handlerNames.indexOf('updateNote'),
      handlerNames.indexOf('removeSpotlightArtist'),
    );
    expect(firstIdRouteIndex).toBeGreaterThan(-1);
    for (const literalHandler of literalHandlers) {
      const literalIndex = handlerNames.indexOf(literalHandler);
      expect(literalIndex).toBeGreaterThan(-1);
      expect(literalIndex).toBeLessThan(firstIdRouteIndex);
    }
  });

  it('answers 204 to both removals and 200 to the PUT and the reorder', () => {
    const statusOf = (methodName: string): unknown =>
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(methodName));
    expect(statusOf('clearArtistOfTheMonth')).toBe(HttpStatus.NO_CONTENT);
    expect(statusOf('removeSpotlightArtist')).toBe(HttpStatus.NO_CONTENT);
    expect(statusOf('setArtistOfTheMonth')).toBe(HttpStatus.OK);
    expect(statusOf('reorderNewStars')).toBe(HttpStatus.OK);
    expect(statusOf('addNewStar')).toBeUndefined();
  });

  it('leaves every route on the class decorators', () => {
    const handlerNames = Object.getOwnPropertyNames(
      AdminStudioSpotlightController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(handlerNames).toHaveLength(8);
    for (const handlerName of handlerNames) {
      expect(Reflect.getMetadata(ROLES_KEY, handlerOf(handlerName))).toBe(
        undefined,
      );
      expect(Reflect.getMetadata(STAFF_ROLES_KEY, handlerOf(handlerName))).toBe(
        undefined,
      );
    }
  });

  it('passes the caller as staffUserId to both placements', async () => {
    const placedArtist = { id: SPOTLIGHT_ID };
    const service = {
      setArtistOfTheMonth: jest.fn().mockResolvedValue(placedArtist),
      addNewStar: jest.fn().mockResolvedValue(placedArtist),
    };
    const controller = new AdminStudioSpotlightController(
      service as unknown as AdminStudioSpotlightService,
    );
    const body = { subprofileId: 'persona-id', note: 'Fresh' };

    await expect(
      controller.setArtistOfTheMonth(STAFF_USER, body),
    ).resolves.toBe(placedArtist);
    await expect(controller.addNewStar(STAFF_USER, body)).resolves.toBe(
      placedArtist,
    );

    expect(service.setArtistOfTheMonth).toHaveBeenCalledWith(
      'staff-user-id',
      body,
    );
    expect(service.addNewStar).toHaveBeenCalledWith('staff-user-id', body);
  });

  it('hands the query, ids and bodies to the service', async () => {
    const service = {
      searchArtists: jest.fn().mockResolvedValue({ items: [] }),
      reorderNewStars: jest.fn().mockResolvedValue([]),
      updateNote: jest.fn().mockResolvedValue({ id: SPOTLIGHT_ID }),
      removeSpotlightArtist: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AdminStudioSpotlightController(
      service as unknown as AdminStudioSpotlightService,
    );

    await controller.searchArtists({ q: 'lux' });
    await controller.reorderNewStars({ spotlightIds: [SPOTLIGHT_ID] });
    await controller.updateNote(SPOTLIGHT_ID, { note: null });
    await controller.removeSpotlightArtist(SPOTLIGHT_ID);

    expect(service.searchArtists).toHaveBeenCalledWith('lux');
    expect(service.reorderNewStars).toHaveBeenCalledWith([SPOTLIGHT_ID]);
    expect(service.updateNote).toHaveBeenCalledWith(SPOTLIGHT_ID, {
      note: null,
    });
    expect(service.removeSpotlightArtist).toHaveBeenCalledWith(SPOTLIGHT_ID);
  });

  it('registers the controller and the service in StudioModule', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StudioModule),
    ).toEqual(expect.arrayContaining([AdminStudioSpotlightController]));
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(expect.arrayContaining([AdminStudioSpotlightService]));
  });
});
