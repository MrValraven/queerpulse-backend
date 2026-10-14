import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { SavedModule } from '../saved/saved.module';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioCurationController } from './admin-studio-curation.controller';
import { AdminStudioCurationService } from './admin-studio-curation.service';
import { AdminStudioDisputesController } from './admin-studio-disputes.controller';
import { AdminStudioReleasesController } from './admin-studio-releases.controller';
import { AdminStudioScenesController } from './admin-studio-scenes.controller';
import { AdminStudioScenesService } from './admin-studio-scenes.service';
import { StudioAppearsOnService } from './studio-appears-on.service';
import { StudioArtistAppearsOnController } from './studio-artist-appears-on.controller';
import { StudioEpisodeAlertsListener } from './studio-episode-alerts.listener';
import { StudioEpisodesController } from './studio-episodes.controller';
import { StudioEpisodesService } from './studio-episodes.service';
import { StudioCreditAlertsListener } from './studio-credit-alerts.listener';
import { StudioCreditsInboxController } from './studio-credits-inbox.controller';
import { StudioCreditsInboxService } from './studio-credits-inbox.service';
import { StudioCurationController } from './studio-curation.controller';
import { StudioCurationService } from './studio-curation.service';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioListeningController } from './studio-listening.controller';
import { StudioMeController } from './studio-me.controller';
import { StudioPersonaCreditsController } from './studio-persona-credits.controller';
import { StudioPersonaCreditsService } from './studio-persona-credits.service';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioModerationService } from './studio-moderation.service';
import { StudioPlaybackPreferencesController } from './studio-playback-preferences.controller';
import { StudioStaffReadsService } from './studio-staff-reads.service';
import { StudioPlaylistListingsController } from './studio-playlist-listings.controller';
import { StudioPlaylistsController } from './studio-playlists.controller';
import { StudioPressKitController } from './studio-press-kit.controller';
import { StudioPressKitService } from './studio-press-kit.service';
import { StudioPreviewsController } from './studio-previews.controller';
import { StudioPreviewsService } from './studio-previews.service';
import { StudioRadioController } from './studio-radio.controller';
import { StudioRadioService } from './studio-radio.service';
import { StudioRelatedArtistsController } from './studio-related-artists.controller';
import { StudioRelatedArtistsService } from './studio-related-artists.service';
import { StudioReleaseExtrasService } from './studio-release-extras.service';
import { StudioReleaseRemindersService } from './studio-release-reminders.service';
import { StudioReleaseToolsController } from './studio-release-tools.controller';
import { StudioReleaseVersionsService } from './studio-release-versions.service';
import { StudioReleasesController } from './studio-releases.controller';
import { StudioScenesController } from './studio-scenes.controller';
import { StudioScenesService } from './studio-scenes.service';
import { StudioScheduledReleasesService } from './studio-scheduled-releases.service';
import { StudioSchedulingService } from './studio-scheduling.service';
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

// The metadata keys `@Throttle({ default: ... })` writes on a handler.
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

const memberControllers = [
  StudioListeningController,
  StudioReleasesController,
  StudioTracksController,
  StudioPlaylistsController,
  StudioPlaylistListingsController,
  StudioStatsController,
  StudioReleaseToolsController,
  StudioPreviewsController,
  StudioPressKitController,
  StudioPlaybackPreferencesController,
  StudioCurationController,
  StudioScenesController,
  StudioPersonaCreditsController,
  StudioCreditsInboxController,
  StudioArtistAppearsOnController,
  StudioRelatedArtistsController,
  StudioRadioController,
  StudioEpisodesController,
];
const adminControllers = [
  AdminStudioAccessController,
  AdminStudioReleasesController,
  AdminStudioDisputesController,
];
// Studio discovery: the admin pages follow `AdminTopicsController`, so
// `RolesOrStaffGuard` with zero staff roles.
const discoveryAdminControllers = [
  AdminStudioCurationController,
  AdminStudioScenesController,
];
const everyController = [
  StudioMeController,
  ...memberControllers,
  ...adminControllers,
  ...discoveryAdminControllers,
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
        'StudioPersonaCreditsController.create',
        'StudioCreditsInboxController.accept',
        'StudioReleaseToolsController.schedule',
        'StudioReleaseToolsController.addVersion',
        'StudioReleaseToolsController.mintPreviewLink',
        'StudioPressKitController.updatePressKit',
        'StudioEpisodesController.publishEpisode',
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

  // Studio open demo pages.
  it('files a dispute at POST /studio/releases/:id/disputes, five per five minutes', () => {
    expect(routePathOf(StudioReleasesController, 'fileDispute')).toBe(
      ':id/disputes',
    );
    // Read off the prototype as a plain object, like `routePathOf`, so the
    // unbound-method rule has nothing to say.
    const handler = (
      StudioReleasesController.prototype as unknown as Record<string, object>
    ).fileDispute!;
    expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBe(5);
    expect(Reflect.getMetadata(THROTTLE_TTL_KEY, handler)).toBe(300000);
  });

  it('documents the 409 the audio confirm answers for a taken-down release', () => {
    const handler = (
      StudioTracksController.prototype as unknown as Record<string, object>
    ).confirmAudio!;
    // `@nestjs/swagger` keeps its constants out of the package exports, so
    // the metadata key `@ApiResponse` writes is spelled out here.
    const responses = Reflect.getMetadata(
      'swagger/apiResponse',
      handler,
    ) as Record<string, { description?: string }>;
    expect(responses['409']?.description).toContain('studio_release_not_draft');
  });

  it('serves the staff release list at GET /admin/studio/releases, ahead of the release read', () => {
    const handlerNames = Object.getOwnPropertyNames(
      AdminStudioReleasesController.prototype,
    );
    expect(handlerNames.indexOf('listReleases')).toBeLessThan(
      handlerNames.indexOf('getRelease'),
    );
    expect(routePathOf(AdminStudioReleasesController, 'listReleases')).toBe(
      '/',
    );
  });

  it('serves the dispute queue and both decisions under /admin/studio/disputes', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminStudioDisputesController),
    ).toBe('admin/studio/disputes');
    expect(routePathOf(AdminStudioDisputesController, 'listDisputes')).toBe(
      '/',
    );
    expect(routePathOf(AdminStudioDisputesController, 'uphold')).toBe(
      ':id/uphold',
    );
    expect(routePathOf(AdminStudioDisputesController, 'reject')).toBe(
      ':id/reject',
    );
  });

  it('serves the player settings at /me/studio-playback behind the Studio grant', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, StudioPlaybackPreferencesController),
    ).toBe('me');
    expect(
      routePathOf(StudioPlaybackPreferencesController, 'getStudioPlayback'),
    ).toBe('studio-playback');
    expect(
      routePathOf(StudioPlaybackPreferencesController, 'updateStudioPlayback'),
    ).toBe('studio-playback');
  });

  it('forwards the report a takedown answers', async () => {
    const moderation = { takedown: jest.fn().mockResolvedValue({}) };
    const controller = new AdminStudioReleasesController(
      {} as StudioCatalogService,
      moderation as unknown as StudioModerationService,
      {} as StudioStaffReadsService,
    );
    await controller.takedown(
      { userId: 'staff-1' } as CurrentUserData,
      'release-1',
      { reason: 'Uploaded twice', reportId: 'report-1' },
    );
    expect(moderation.takedown).toHaveBeenCalledWith(
      'staff-1',
      'release-1',
      'Uploaded twice',
      'report-1',
    );
  });

  it.each(
    discoveryAdminControllers.map((controller) => [
      controller.name,
      controller,
    ]),
  )(
    'opens %s to moderators and admins through the tier, with no staff grant',
    (_name, controller) => {
      expect(guardsOf(controller)).toEqual([
        ActiveMemberGuard,
        RolesOrStaffGuard,
      ]);
      expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual([
        UserRole.Moderator,
        UserRole.Admin,
      ]);
      expect(Reflect.getMetadata(STAFF_ROLES_KEY, controller)).toBeUndefined();
    },
  );

  it('registers every discovery service and the credit alert listener', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioCurationService,
        AdminStudioCurationService,
        StudioScenesService,
        AdminStudioScenesService,
        StudioPersonaCreditsService,
        StudioCreditsInboxService,
        StudioCreditAlertsListener,
        StudioAppearsOnService,
        StudioRelatedArtistsService,
        StudioRadioService,
      ]),
    );
  });

  // Express matches routes in registration order and Nest registers a
  // controller's handlers in declaration order.
  it('declares the admin scene reorder and event search ahead of the :id routes', () => {
    const handlerNames = Object.getOwnPropertyNames(
      AdminStudioScenesController.prototype,
    );
    for (const literalHandler of ['reorder', 'eventSearch']) {
      expect(handlerNames.indexOf(literalHandler)).toBeLessThan(
        handlerNames.indexOf('update'),
      );
    }
    expect(routePathOf(AdminStudioScenesController, 'reorder')).toBe('reorder');
    expect(routePathOf(AdminStudioScenesController, 'eventSearch')).toBe(
      'event-search',
    );
    expect(routePathOf(AdminStudioScenesController, 'update')).toBe(':id');
  });

  it('serves the persona credit routes under the track path the request log already skips', () => {
    expect(routePathOf(StudioPersonaCreditsController, 'create')).toBe(
      'tracks/:id/persona-credits',
    );
    expect(routePathOf(StudioPersonaCreditsController, 'remove')).toBe(
      'tracks/:id/persona-credits/:creditId',
    );
  });

  // Studio v3 artist tools.
  it('registers the artist tools services, the drop and the Saved module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioReleaseExtrasService,
        StudioSchedulingService,
        StudioScheduledReleasesService,
        StudioReleaseRemindersService,
        StudioReleaseVersionsService,
        StudioPreviewsService,
        StudioPressKitService,
      ]),
    );
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, StudioModule)).toEqual(
      expect.arrayContaining([SavedModule]),
    );
  });

  it('mounts the artist tools routes at the contract paths', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, StudioReleaseToolsController),
    ).toBe('studio/releases');
    expect(routePathOf(StudioReleaseToolsController, 'schedule')).toBe(
      ':id/schedule',
    );
    expect(routePathOf(StudioReleaseToolsController, 'unschedule')).toBe(
      ':id/unschedule',
    );
    expect(routePathOf(StudioReleaseToolsController, 'addVersion')).toBe(
      ':id/versions',
    );
    expect(routePathOf(StudioReleaseToolsController, 'mintPreviewLink')).toBe(
      ':id/preview-link',
    );
    expect(routePathOf(StudioReleaseToolsController, 'revokePreviewLink')).toBe(
      ':id/preview-link',
    );
    expect(routePathOf(StudioReleaseToolsController, 'setReminder')).toBe(
      ':id/reminder',
    );
    expect(routePathOf(StudioReleaseToolsController, 'clearReminder')).toBe(
      ':id/reminder',
    );
    expect(Reflect.getMetadata(PATH_METADATA, StudioPreviewsController)).toBe(
      'studio/previews',
    );
    expect(routePathOf(StudioPreviewsController, 'getPreview')).toBe(':token');
    expect(routePathOf(StudioPreviewsController, 'getPreviewStream')).toBe(
      ':token/tracks/:trackId/stream',
    );
    expect(Reflect.getMetadata(PATH_METADATA, StudioPressKitController)).toBe(
      'studio/artists',
    );
    expect(routePathOf(StudioPressKitController, 'getPressKit')).toBe(
      ':subprofileId/press-kit',
    );
    expect(routePathOf(StudioPressKitController, 'updatePressKit')).toBe(
      ':subprofileId/press-kit',
    );
  });

  it('answers 200 to the artist tools posts and 204 to the reminder PUT, the reminder removal and the link removal', () => {
    const codeOf = (methodName: string): unknown =>
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        (
          StudioReleaseToolsController.prototype as unknown as Record<
            string,
            object
          >
        )[methodName]!,
      );
    expect(codeOf('schedule')).toBe(200);
    expect(codeOf('unschedule')).toBe(200);
    expect(codeOf('addVersion')).toBe(200);
    expect(codeOf('mintPreviewLink')).toBe(200);
    expect(codeOf('revokePreviewLink')).toBe(204);
    expect(codeOf('setReminder')).toBe(204);
    expect(codeOf('clearReminder')).toBe(204);
  });

  it('throttles the preview routes to 30 a minute', () => {
    expect(
      Reflect.getMetadata(THROTTLE_LIMIT_KEY, StudioPreviewsController),
    ).toBe(30);
    expect(
      Reflect.getMetadata(THROTTLE_TTL_KEY, StudioPreviewsController),
    ).toBe(60000);
  });

  // Studio artist kinds.
  it('registers the episodes service and the episode alert listener', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioEpisodesService,
        StudioEpisodeAlertsListener,
      ]),
    );
  });

  it('mounts the episode routes and the formats route at the contract paths', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StudioEpisodesController)).toBe(
      'studio',
    );
    expect(routePathOf(StudioEpisodesController, 'listLatestEpisodes')).toBe(
      'episodes/latest',
    );
    expect(routePathOf(StudioEpisodesController, 'publishEpisode')).toBe(
      'tracks/:id/publish',
    );
    expect(routePathOf(StudioListeningController, 'listFormats')).toBe(
      'formats',
    );
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        (
          StudioEpisodesController.prototype as unknown as Record<
            string,
            object
          >
        ).publishEpisode!,
      ),
    ).toBe(200);
  });
});
