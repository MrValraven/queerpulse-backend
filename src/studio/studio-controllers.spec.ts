import {
  GUARDS_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioReleasesController } from './admin-studio-releases.controller';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioListeningController } from './studio-listening.controller';
import { StudioMeController } from './studio-me.controller';
import { StudioPlaylistListingsController } from './studio-playlist-listings.controller';
import { StudioPlaylistsController } from './studio-playlists.controller';
import { StudioReleasesController } from './studio-releases.controller';
import { StudioStatsController } from './studio-stats.controller';
import { StudioTracksController } from './studio-tracks.controller';
import { StudioModule } from './studio.module';

const guardsOf = (controller: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];

const routePathOf = (
  controller: { prototype: unknown },
  methodName: string,
): unknown => {
  const handler = (controller.prototype as Record<string, object | undefined>)[
    methodName
  ];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return Reflect.getMetadata(PATH_METADATA, handler);
};

const memberControllers = [
  StudioListeningController,
  StudioReleasesController,
  StudioTracksController,
  StudioPlaylistsController,
  StudioPlaylistListingsController,
  StudioStatsController,
];
const adminControllers = [
  AdminStudioAccessController,
  AdminStudioReleasesController,
];
const everyController = [
  StudioMeController,
  ...memberControllers,
  ...adminControllers,
];

describe('Studio controllers', () => {
  it('registers every Studio controller in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StudioModule),
    ).toEqual(expect.arrayContaining(everyController));
  });

  it.each(everyController.map((controller) => [controller.name, controller]))(
    'tags %s with the studio feature',
    (_name, controller) => {
      expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBe('studio');
    },
  );

  it.each(memberControllers.map((controller) => [controller.name, controller]))(
    'guards %s with the active member check, then the Studio grant',
    (_name, controller) => {
      expect(guardsOf(controller)).toEqual([
        ActiveMemberGuard,
        StudioAccessGuard,
      ]);
    },
  );

  it('answers GET /studio/me without the Studio grant', () => {
    expect(guardsOf(StudioMeController)).toEqual([ActiveMemberGuard]);
  });

  it.each(adminControllers.map((controller) => [controller.name, controller]))(
    'opens %s to moderators and admins only',
    (_name, controller) => {
      expect(guardsOf(controller)).toEqual([ActiveMemberGuard, RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual([
        UserRole.Moderator,
        UserRole.Admin,
      ]);
    },
  );

  it('binds the restriction check to the writes other members read', () => {
    const restrictedHandlers = memberControllers.flatMap((controller) => {
      const prototype = controller.prototype as unknown as Record<
        string,
        unknown
      >;
      return Object.getOwnPropertyNames(prototype)
        .filter((methodName) => methodName !== 'constructor')
        .filter((methodName) =>
          guardsOf(prototype[methodName] as object).includes(
            NotRestrictedGuard,
          ),
        )
        .map((methodName) => `${controller.name}.${methodName}`);
    });
    expect(restrictedHandlers.sort()).toEqual(
      [
        'StudioReleasesController.publish',
        'StudioReleasesController.update',
        'StudioTracksController.updateTrack',
        'StudioPlaylistsController.create',
        'StudioPlaylistsController.update',
      ].sort(),
    );
  });

  // Express matches routes in registration order and Nest registers a
  // controller's handlers in declaration order, so `mine` must come first.
  it('registers GET /studio/playlists/mine before GET /studio/playlists/:id', () => {
    const handlerNames = Object.getOwnPropertyNames(
      StudioPlaylistsController.prototype,
    );
    expect(handlerNames.indexOf('listMine')).toBeLessThan(
      handlerNames.indexOf('getPlaylist'),
    );
    expect(routePathOf(StudioPlaylistsController, 'listMine')).toBe('mine');
    expect(routePathOf(StudioPlaylistsController, 'getPlaylist')).toBe(':id');
  });

  // The profile page knows a member by slug only (contract revision).
  it('addresses a member playlist list by profile slug', () => {
    expect(routePathOf(StudioPlaylistListingsController, 'listForMember')).toBe(
      'members/:slug/playlists',
    );
  });
});
