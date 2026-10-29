import { ParseUUIDPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import {
  NO_STALE_READ_CDN_CACHE,
  PUBLIC_READ_CACHE,
} from '../common/public-read-cache';
import { ModAuditService } from '../moderation/mod-audit.service';
import { SavedModule } from '../saved/saved.module';
import { STUDIO_LANDING_SCOPED_KEY_HANDLERS } from '../storage/shared-upload-handlers';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioCurationController } from './admin-studio-curation.controller';
import { AdminStudioCurationService } from './admin-studio-curation.service';
import { AdminStudioAccessRequestsController } from './admin-studio-access-requests.controller';
import { AdminStudioLandingContentService } from './admin-studio-landing-content.service';
import { AdminStudioLandingController } from './admin-studio-landing.controller';
import { AdminStudioLandingPhotosService } from './admin-studio-landing-photos.service';
import { AdminStudioLandingPreviewsService } from './admin-studio-landing-previews.service';
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
import { StudioWelcomeController } from './studio-welcome.controller';
import { StudioStaffReadsService } from './studio-staff-reads.service';
import { StudioPlaylistListingsController } from './studio-playlist-listings.controller';
import { StudioPlaylistEditorBlockListener } from './studio-playlist-editor-block.listener';
import { StudioPlaylistEditorsController } from './studio-playlist-editors.controller';
import { StudioPlaylistEditorsService } from './studio-playlist-editors.service';
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
import { StudioArtistMilestonesService } from './studio-artist-milestones.service';
import { StudioArtistPlacementsService } from './studio-artist-placements.service';
import { StudioArtistSupporterController } from './studio-artist-supporter.controller';
import { StudioListeningHistoryController } from './studio-listening-history.controller';
import { StudioListeningHistoryService } from './studio-listening-history.service';
import { StudioListeningPruneService } from './studio-listening-prune.service';
import { StudioPlayGate } from './studio-play-gate';
import { StudioPlayMilestonesService } from './studio-play-milestones.service';
import { StudioPlaysController } from './studio-plays.controller';
import { StudioPlaysService } from './studio-plays.service';
import { StudioArtistPlaysService } from './studio-artist-plays.service';
import { StudioSupportersService } from './studio-supporters.service';
import { StudioFollowerMilestonesListener } from './studio-follower-milestones.listener';
import { StudioMilestoneSweepService } from './studio-milestone-sweep.service';
import { StudioMilestonesController } from './studio-milestones.controller';
import { StudioStatsController } from './studio-stats.controller';
import { StudioTracksController } from './studio-tracks.controller';
import { StudioBuyerPurchasesService } from './studio-buyer-purchases.service';
import { StudioKeptAudioService } from './studio-kept-audio.service';
import { StudioPaymentMethodsController } from './studio-payment-methods.controller';
import { StudioPaymentMethodsService } from './studio-payment-methods.service';
import { StudioPurchaseAlertsListener } from './studio-purchase-alerts.listener';
import { StudioPurchaseExpiryService } from './studio-purchase-expiry.service';
import { StudioPurchaseLibraryController } from './studio-purchase-library.controller';
import { StudioPurchaseLibraryService } from './studio-purchase-library.service';
import { StudioPurchaseWallService } from './studio-purchase-wall.service';
import { StudioPurchasesController } from './studio-purchases.controller';
import { StudioPurchasesService } from './studio-purchases.service';
import { StudioSalesController } from './studio-sales.controller';
import { StudioSalesService } from './studio-sales.service';
import { StudioAccessAlertsListener } from './studio-access-alerts.listener';
import { StudioAccessRequestsController } from './studio-access-requests.controller';
import { StudioAccessRequestsService } from './studio-access-requests.service';
import { StudioFoundingArtistsController } from './studio-founding-artists.controller';
import { StudioFoundingArtistsService } from './studio-founding-artists.service';
import { StudioLandingAlertsListener } from './studio-landing-alerts.listener';
import { StudioLandingController } from './studio-landing.controller';
import { StudioLandingPreviewsController } from './studio-landing-previews.controller';
import { StudioLandingPreviewsService } from './studio-landing-previews.service';
import { StudioLandingReadService } from './studio-landing-read.service';
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

const handlerOf = (
  controller: { prototype: unknown },
  methodName: string,
): object =>
  (controller.prototype as Record<string, object>)[methodName] as object;

// The metadata keys `@Throttle({ default: ... })` writes on a handler.
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

const memberControllers = [
  StudioListeningController,
  StudioReleasesController,
  StudioTracksController,
  StudioPlaylistsController,
  StudioPlaylistEditorsController,
  StudioPlaylistListingsController,
  StudioStatsController,
  StudioMilestonesController,
  StudioPlaysController,
  StudioListeningHistoryController,
  StudioArtistSupporterController,
  StudioReleaseToolsController,
  StudioPreviewsController,
  StudioPressKitController,
  StudioPlaybackPreferencesController,
  StudioWelcomeController,
  StudioCurationController,
  StudioScenesController,
  StudioPersonaCreditsController,
  StudioCreditsInboxController,
  StudioArtistAppearsOnController,
  StudioRelatedArtistsController,
  StudioRadioController,
  StudioEpisodesController,
  StudioPaymentMethodsController,
  StudioPurchasesController,
  StudioSalesController,
  StudioLandingPreviewsController,
  StudioFoundingArtistsController,
];
const adminControllers = [
  AdminStudioAccessController,
  AdminStudioReleasesController,
  AdminStudioDisputesController,
  AdminStudioAccessRequestsController,
];
// Studio discovery: the admin pages follow `AdminTopicsController`, so
// `RolesOrStaffGuard` with zero staff roles.
const discoveryAdminControllers = [
  AdminStudioCurationController,
  AdminStudioScenesController,
  AdminStudioLandingController,
];
const everyController = [
  StudioMeController,
  StudioPurchaseLibraryController,
  StudioLandingController,
  StudioAccessRequestsController,
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
        'StudioPlaylistEditorsController.addEditors',
        'StudioPlaylistEditorsController.respondToInvite',
        'StudioPersonaCreditsController.create',
        'StudioCreditsInboxController.accept',
        'StudioReleaseToolsController.schedule',
        'StudioReleaseToolsController.addVersion',
        'StudioReleaseToolsController.mintPreviewLink',
        'StudioPressKitController.updatePressKit',
        'StudioEpisodesController.publishEpisode',
        'StudioPaymentMethodsController.replaceMethods',
        'StudioPurchasesController.createPurchase',
        'StudioPurchasesController.updateWall',
        'StudioSalesController.confirm',
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

  // Liked songs: `liked` is a fixed segment too, so it also comes first.
  it('registers GET /studio/playlists/liked before GET /studio/playlists/:id', () => {
    const handlerNames = Object.getOwnPropertyNames(
      StudioPlaylistsController.prototype,
    );
    expect(handlerNames.indexOf('listLiked')).toBeGreaterThan(-1);
    expect(handlerNames.indexOf('listLiked')).toBeLessThan(
      handlerNames.indexOf('getPlaylist'),
    );
    expect(routePathOf(StudioPlaylistsController, 'listLiked')).toBe('liked');
  });

  // Collaborative playlists.
  it('registers DELETE :id/editors/me before DELETE :id/editors/:editorId', () => {
    const handlerNames = Object.getOwnPropertyNames(
      StudioPlaylistEditorsController.prototype,
    );
    expect(handlerNames.indexOf('leave')).toBeLessThan(
      handlerNames.indexOf('removeEditor'),
    );
    expect(routePathOf(StudioPlaylistEditorsController, 'leave')).toBe(
      ':id/editors/me',
    );
    expect(routePathOf(StudioPlaylistEditorsController, 'removeEditor')).toBe(
      ':id/editors/:editorId',
    );
  });

  it('serves the editor routes under studio/playlists', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, StudioPlaylistEditorsController),
    ).toBe('studio/playlists');
    expect(routePathOf(StudioPlaylistEditorsController, 'listEditors')).toBe(
      ':id/editors',
    );
    expect(routePathOf(StudioPlaylistEditorsController, 'addEditors')).toBe(
      ':id/editors',
    );
    expect(
      routePathOf(StudioPlaylistEditorsController, 'respondToInvite'),
    ).toBe(':id/editor-invite');
    expect(routePathOf(StudioPlaylistEditorsController, 'listCandidates')).toBe(
      ':id/editor-candidates',
    );
  });

  it('throttles editor invitations to ten a minute and answers them with 200', () => {
    const handler = (
      StudioPlaylistEditorsController.prototype as unknown as Record<
        string,
        object
      >
    ).addEditors!;
    expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBe(10);
    expect(Reflect.getMetadata(THROTTLE_TTL_KEY, handler)).toBe(60000);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('registers the editors service and the block listener', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioPlaylistEditorsService,
        StudioPlaylistEditorBlockListener,
      ]),
    );
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

  it('serves the Studio welcome at /me/studio-welcome behind the Studio grant', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StudioWelcomeController)).toBe(
      'me',
    );
    expect(routePathOf(StudioWelcomeController, 'getStudioWelcome')).toBe(
      'studio-welcome',
    );
    expect(routePathOf(StudioWelcomeController, 'updateStudioWelcome')).toBe(
      'studio-welcome',
    );
  });

  it('forwards the report a takedown answers', async () => {
    const moderation = { takedown: jest.fn().mockResolvedValue({}) };
    const controller = new AdminStudioReleasesController(
      {} as StudioCatalogService,
      moderation as unknown as StudioModerationService,
      {} as StudioStaffReadsService,
      {} as ModAuditService,
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

  describe('audits a staff read of a scheduled release and of a published show with a draft episode, and skips a published album', () => {
    it.each([
      [
        'a scheduled release',
        { status: 'scheduled', type: 'album', tracks: [] },
        true,
      ],
      [
        'a draft release',
        { status: 'draft', type: 'single', tracks: [] },
        true,
      ],
      [
        'a published show with a draft episode',
        {
          status: 'published',
          type: 'podcast',
          tracks: [{ publishedAt: null }],
        },
        true,
      ],
      [
        'a published album',
        { status: 'published', type: 'album', tracks: [{ publishedAt: null }] },
        false,
      ],
      [
        'a taken-down release',
        { status: 'taken_down', type: 'album', tracks: [] },
        false,
      ],
    ])(
      'audits a staff read of %s when it is unpublished',
      async (_label, response, isAudited) => {
        const catalog = {
          getReleaseForStaff: jest.fn().mockResolvedValue(response),
        };
        const modAudit = {
          writeAuditLog: jest.fn().mockResolvedValue('audit-1'),
        };
        const controller = new AdminStudioReleasesController(
          catalog as never,
          {} as never,
          {} as never,
          modAudit as never,
        );
        await expect(
          controller.getRelease(
            { userId: 'staff-1' } as CurrentUserData,
            'release-1',
          ),
        ).resolves.toBe(response);
        expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(isAudited ? 1 : 0);
        if (isAudited) {
          expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
            null,
            'staff-1',
            'creator_draft_viewed',
            undefined,
            '{"v":1,"kind":"studio_release","draftId":"release-1","surface":"studio_staff"}',
          );
        }
      },
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

  it('mounts the dashboard reads at the contract paths', () => {
    expect(routePathOf(StudioStatsController, 'listPlacements')).toBe(
      ':subprofileId/placements',
    );
    expect(routePathOf(StudioStatsController, 'listMilestones')).toBe(
      ':subprofileId/milestones',
    );
    expect(Reflect.getMetadata(PATH_METADATA, StudioMilestonesController)).toBe(
      'studio/milestones',
    );
    expect(routePathOf(StudioMilestonesController, 'getMilestoneCard')).toBe(
      ':milestoneId',
    );
  });

  it('registers the dashboard services, the follower milestone listener and the sweep', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioArtistPlacementsService,
        StudioArtistMilestonesService,
        StudioFollowerMilestonesListener,
        StudioMilestoneSweepService,
      ]),
    );
  });

  it('hands the milestone id to the card read as typed, so a malformed id gets the same 404', async () => {
    const milestones = { getMilestoneCard: jest.fn().mockResolvedValue({}) };
    await new StudioMilestonesController(
      milestones as unknown as StudioArtistMilestonesService,
    ).getMilestoneCard({ userId: 'viewer-1' } as CurrentUserData, 'not-a-uuid');
    expect(milestones.getMilestoneCard).toHaveBeenCalledWith(
      'viewer-1',
      'not-a-uuid',
    );
  });

  it('passes the placements cursor through', async () => {
    const placements = {
      listPlacements: jest.fn().mockResolvedValue({ items: [] }),
    };
    await new StudioStatsController(
      {} as never,
      placements as unknown as StudioArtistPlacementsService,
      {} as never,
      {} as never,
      {} as never,
    ).listPlacements({ userId: 'viewer-1' } as CurrentUserData, 'persona-1', {
      cursor: 'abc',
    });
    expect(placements.listPlacements).toHaveBeenCalledWith(
      'viewer-1',
      'persona-1',
      'abc',
    );
  });

  describe('Studio listening', () => {
    const VIEWER_ID = 'viewer-1';
    const TRACK_ID = '11111111-1111-4111-8111-111111111111';
    const viewer = { userId: VIEWER_ID } as CurrentUserData;

    it('mounts the listening routes at the contract paths', () => {
      expect(routePathOf(StudioPlaysController, 'recordPlay')).toBe('plays');
      expect(
        ['getSummary', 'listRecent', 'clearHistory', 'listSupporting'].map(
          (handler) => routePathOf(StudioListeningHistoryController, handler),
        ),
      ).toEqual([
        'studio-listening',
        'studio-listening/recent',
        'studio-listening',
        'studio-listening/supporting',
      ]);
      expect(
        ['getSupporter', 'setSupporter', 'removeSupporter'].map((handler) =>
          routePathOf(StudioArtistSupporterController, handler),
        ),
      ).toEqual([
        ':subprofileId/supporter',
        ':subprofileId/supporter',
        ':subprofileId/supporter',
      ]);
      expect([
        routePathOf(StudioStatsController, 'getPlays'),
        routePathOf(StudioStatsController, 'listTopSupporters'),
      ]).toEqual([':subprofileId/plays', ':subprofileId/supporters']);
    });

    it('declares HttpCode 204 on a void play handler that carries no throttle override', async () => {
      const plays = { recordPlay: jest.fn().mockResolvedValue(undefined) };
      const controller = new StudioPlaysController(
        plays as unknown as StudioPlaysService,
      );
      const playHandler = handlerOf(StudioPlaysController, 'recordPlay');
      await expect(
        controller.recordPlay(viewer, { trackId: TRACK_ID }),
      ).resolves.toBeUndefined();
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, playHandler)).toBe(204);
      expect(
        Reflect.getMetadata(THROTTLE_LIMIT_KEY, playHandler),
      ).toBeUndefined();
      expect(plays.recordPlay).toHaveBeenCalledWith(VIEWER_ID, TRACK_ID);
    });

    it('answers 204 to a cleared history and a withdrawn opt-in', async () => {
      const history = { clearHistory: jest.fn().mockResolvedValue(undefined) };
      const supporters = {
        removeSupporter: jest.fn().mockResolvedValue(undefined),
      };
      await expect(
        new StudioListeningHistoryController(
          history as unknown as StudioListeningHistoryService,
          {} as never,
        ).clearHistory(viewer),
      ).resolves.toBeUndefined();
      await expect(
        new StudioArtistSupporterController(
          supporters as unknown as StudioSupportersService,
        ).removeSupporter(viewer, TRACK_ID),
      ).resolves.toBeUndefined();
      expect(
        [
          handlerOf(StudioListeningHistoryController, 'clearHistory'),
          handlerOf(StudioArtistSupporterController, 'removeSupporter'),
        ].map((handler) => Reflect.getMetadata(HTTP_CODE_METADATA, handler)),
      ).toEqual([204, 204]);
      expect(history.clearHistory).toHaveBeenCalledWith(VIEWER_ID);
      expect(supporters.removeSupporter).toHaveBeenCalledWith(
        VIEWER_ID,
        TRACK_ID,
      );
    });

    it('reads the default range when none is sent', async () => {
      const history = { getSummary: jest.fn().mockResolvedValue({}) };
      const controller = new StudioListeningHistoryController(
        history as unknown as StudioListeningHistoryService,
        {} as never,
      );
      await controller.getSummary(viewer, {});
      await controller.getSummary(viewer, { range: '12m' });
      expect(history.getSummary.mock.calls).toEqual([
        [VIEWER_ID, '4w'],
        [VIEWER_ID, '12m'],
      ]);
    });

    it('passes the supporter identity and the artist route reads to the services', async () => {
      const supporters = {
        setSupporter: jest.fn().mockResolvedValue({}),
        listTopSupporters: jest.fn().mockResolvedValue({}),
      };
      const artistPlays = { getArtistPlays: jest.fn().mockResolvedValue({}) };
      await new StudioArtistSupporterController(
        supporters as unknown as StudioSupportersService,
      ).setSupporter(viewer, 'persona-1', { shownAsSubprofileId: null });
      const stats = new StudioStatsController(
        {} as never,
        {} as never,
        {} as never,
        artistPlays as unknown as StudioArtistPlaysService,
        supporters as unknown as StudioSupportersService,
      );
      await stats.getPlays(viewer, 'persona-1', { days: 28 });
      await stats.listTopSupporters(viewer, 'persona-1');
      expect(supporters.setSupporter).toHaveBeenCalledWith(
        VIEWER_ID,
        'persona-1',
        null,
      );
      expect(artistPlays.getArtistPlays).toHaveBeenCalledWith(
        VIEWER_ID,
        'persona-1',
      );
      expect(supporters.listTopSupporters).toHaveBeenCalledWith(
        VIEWER_ID,
        'persona-1',
      );
    });

    it('registers the listening entities, services, gate and prune', () => {
      expect(
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
      ).toEqual(
        expect.arrayContaining([
          StudioPlayGate,
          StudioPlaysService,
          StudioPlayMilestonesService,
          StudioListeningHistoryService,
          StudioSupportersService,
          StudioArtistPlaysService,
          StudioListeningPruneService,
        ]),
      );
    });
  });

  describe('Studio purchases', () => {
    const VIEWER_ID = 'viewer-1';
    const PERSONA_ID = '22222222-2222-4222-8222-222222222222';
    const PURCHASE_ID = '33333333-3333-4333-8333-333333333333';
    const RELEASE_ID = '44444444-4444-4444-8444-444444444444';
    const viewer = { userId: VIEWER_ID } as CurrentUserData;

    // `@Param(name, ParseUUIDPipe)` records each route param with its pipes
    // under ROUTE_ARGS_METADATA on the controller class, keyed by handler.
    const uuidParamsOf = (
      controller: { prototype: unknown },
      methodName: string,
    ): string[] => {
      const routeArguments =
        (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) as
          Record<string, { data?: unknown; pipes?: unknown[] }> | undefined) ??
        {};
      return Object.values(routeArguments)
        .filter(
          (routeArgument) =>
            typeof routeArgument.data === 'string' &&
            (routeArgument.pipes ?? []).includes(ParseUUIDPipe),
        )
        .map((routeArgument) => routeArgument.data as string)
        .sort();
    };

    it('mounts the purchase routes at the contract paths', () => {
      expect(
        [
          'releaseOffer',
          'trackOffer',
          'issueReference',
          'createPurchase',
          'cancelPurchase',
          'getWall',
          'updateWall',
          'listReleaseWall',
        ].map((handler) => routePathOf(StudioPurchasesController, handler)),
      ).toEqual([
        'releases/:releaseId/offer',
        'tracks/:trackId/offer',
        'purchases/reference-code',
        'purchases',
        'purchases/:purchaseId/cancel',
        'purchases/:purchaseId/wall',
        'purchases/:purchaseId/wall',
        'releases/:releaseId/wall',
      ]);
      expect(
        [
          'listToConfirm',
          'confirm',
          'decline',
          'listSales',
          'salesTotals',
          'pendingCount',
        ].map((handler) => routePathOf(StudioSalesController, handler)),
      ).toEqual([
        'artists/:subprofileId/purchases',
        'artists/:subprofileId/purchases/:purchaseId/confirm',
        'artists/:subprofileId/purchases/:purchaseId/decline',
        'artists/:subprofileId/sales',
        'artists/:subprofileId/sales/totals',
        'sales/pending-count',
      ]);
      expect(
        ['listMine', 'download'].map((handler) =>
          routePathOf(StudioPurchaseLibraryController, handler),
        ),
      ).toEqual([
        'me/studio-purchases',
        'studio/purchases/:purchaseId/tracks/:trackId/download',
      ]);
      expect(
        ['getMethods', 'replaceMethods'].map((handler) =>
          routePathOf(StudioPaymentMethodsController, handler),
        ),
      ).toEqual([
        ':subprofileId/payment-methods',
        ':subprofileId/payment-methods',
      ]);
      expect(
        [
          StudioPaymentMethodsController,
          StudioPurchasesController,
          StudioPurchaseLibraryController,
          StudioSalesController,
        ].map((controller) => Reflect.getMetadata(PATH_METADATA, controller)),
      ).toEqual(['studio/artists', 'studio', '/', 'studio']);
    });

    it('opens the buyer list and the download to signed-in active members without the Studio grant', () => {
      expect(guardsOf(StudioPurchaseLibraryController)).toEqual([
        ActiveMemberGuard,
      ]);
      expect(
        Reflect.getMetadata(FEATURE_KEY, StudioPurchaseLibraryController),
      ).toBe('studio');
    });

    it('throttles purchase creation to ten an hour and reference codes to thirty an hour', () => {
      const createHandler = handlerOf(
        StudioPurchasesController,
        'createPurchase',
      );
      const referenceHandler = handlerOf(
        StudioPurchasesController,
        'issueReference',
      );
      expect([
        Reflect.getMetadata(THROTTLE_LIMIT_KEY, createHandler),
        Reflect.getMetadata(THROTTLE_TTL_KEY, createHandler),
        Reflect.getMetadata(THROTTLE_LIMIT_KEY, referenceHandler),
        Reflect.getMetadata(THROTTLE_TTL_KEY, referenceHandler),
      ]).toEqual([10, 3_600_000, 30, 3_600_000]);
    });

    it('answers 204 to cancel, confirm and decline', () => {
      expect(
        [
          handlerOf(StudioPurchasesController, 'cancelPurchase'),
          handlerOf(StudioSalesController, 'confirm'),
          handlerOf(StudioSalesController, 'decline'),
        ].map((handler) => Reflect.getMetadata(HTTP_CODE_METADATA, handler)),
      ).toEqual([204, 204, 204]);
    });

    it('validates every id in a purchase route as a UUID', () => {
      expect([
        uuidParamsOf(StudioPaymentMethodsController, 'getMethods'),
        uuidParamsOf(StudioPaymentMethodsController, 'replaceMethods'),
        uuidParamsOf(StudioPurchasesController, 'releaseOffer'),
        uuidParamsOf(StudioPurchasesController, 'trackOffer'),
        uuidParamsOf(StudioPurchasesController, 'cancelPurchase'),
        uuidParamsOf(StudioPurchasesController, 'getWall'),
        uuidParamsOf(StudioPurchasesController, 'updateWall'),
        uuidParamsOf(StudioPurchasesController, 'listReleaseWall'),
        uuidParamsOf(StudioPurchaseLibraryController, 'download'),
        uuidParamsOf(StudioSalesController, 'listToConfirm'),
        uuidParamsOf(StudioSalesController, 'confirm'),
        uuidParamsOf(StudioSalesController, 'decline'),
        uuidParamsOf(StudioSalesController, 'listSales'),
        uuidParamsOf(StudioSalesController, 'salesTotals'),
      ]).toEqual([
        ['subprofileId'],
        ['subprofileId'],
        ['releaseId'],
        ['trackId'],
        ['purchaseId'],
        ['purchaseId'],
        ['purchaseId'],
        ['releaseId'],
        ['purchaseId', 'trackId'],
        ['subprofileId'],
        ['purchaseId', 'subprofileId'],
        ['purchaseId', 'subprofileId'],
        ['subprofileId'],
        ['subprofileId'],
      ]);
    });

    it('passes the decline body and the cursor through', async () => {
      const sales = {
        decline: jest.fn().mockResolvedValue(undefined),
        listToConfirm: jest.fn().mockResolvedValue({ items: [] }),
        listSales: jest.fn().mockResolvedValue({ items: [] }),
      };
      const purchases = {
        create: jest.fn().mockResolvedValue({}),
      };
      const wall = { listWall: jest.fn().mockResolvedValue({ items: [] }) };
      const library = { listMine: jest.fn().mockResolvedValue({ items: [] }) };
      const salesController = new StudioSalesController(
        sales as unknown as StudioSalesService,
      );
      await expect(
        salesController.decline(viewer, PERSONA_ID, PURCHASE_ID, {
          reason: 'other',
          note: 'x',
        }),
      ).resolves.toBeUndefined();
      await salesController.listToConfirm(viewer, PERSONA_ID, {
        cursor: 'abc',
      });
      await salesController.listSales(viewer, PERSONA_ID, {});
      const purchasesController = new StudioPurchasesController(
        purchases as unknown as StudioPurchasesService,
        wall as unknown as StudioPurchaseWallService,
      );
      await purchasesController.listReleaseWall(viewer, RELEASE_ID, {
        cursor: 'def',
      });
      const createBody = {
        releaseId: RELEASE_ID,
        amountCents: 700,
        payerName: null,
        isOnWall: false,
        shownAsSubprofileId: null,
        referenceCode: 'ABC234',
        referenceToken: 'token',
      };
      await purchasesController.createPurchase(viewer, createBody);
      await new StudioPurchaseLibraryController(
        library as unknown as StudioPurchaseLibraryService,
      ).listMine(viewer, { status: 'confirmed', cursor: 'ghi' });
      expect(sales.decline).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_ID,
        PURCHASE_ID,
        { reason: 'other', note: 'x' },
      );
      expect(sales.listToConfirm).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_ID,
        'abc',
      );
      expect(sales.listSales).toHaveBeenCalledWith(
        VIEWER_ID,
        PERSONA_ID,
        undefined,
      );
      expect(wall.listWall).toHaveBeenCalledWith(VIEWER_ID, RELEASE_ID, 'def');
      expect(purchases.create).toHaveBeenCalledWith(VIEWER_ID, createBody);
      expect(library.listMine).toHaveBeenCalledWith(VIEWER_ID, {
        status: 'confirmed',
        cursor: 'ghi',
      });
    });

    it('registers the purchase entities, services, listener and cron', () => {
      expect(
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
      ).toEqual(
        expect.arrayContaining([
          StudioPaymentMethodsService,
          StudioBuyerPurchasesService,
          StudioPurchasesService,
          StudioPurchaseWallService,
          StudioPurchaseLibraryService,
          StudioSalesService,
          StudioKeptAudioService,
          StudioPurchaseExpiryService,
          StudioPurchaseAlertsListener,
        ]),
      );
    });
  });

  describe('Studio landing v2', () => {
    const headersOf = (
      controller: { prototype: unknown },
      methodName: string,
    ): Record<string, unknown> => {
      const declared =
        (Reflect.getMetadata(
          HEADERS_METADATA,
          handlerOf(controller, methodName),
        ) as { name: string; value: unknown }[] | undefined) ?? [];
      return Object.fromEntries(
        declared.map((header) => [header.name, header.value]),
      );
    };

    it('serves the landing reads to everyone with no guard', () => {
      expect(guardsOf(StudioLandingController)).toEqual([]);
      for (const handler of ['getLanding', 'getPreviewStream']) {
        expect(
          Reflect.getMetadata(
            IS_PUBLIC_KEY,
            handlerOf(StudioLandingController, handler),
          ),
        ).toBe(true);
      }
    });

    it('throttles the preview stream at 30 a minute and stores nothing in caches', () => {
      const handler = handlerOf(StudioLandingController, 'getPreviewStream');
      expect([
        Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler),
        Reflect.getMetadata(THROTTLE_TTL_KEY, handler),
      ]).toEqual([30, 60_000]);
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
        { name: 'Cache-Control', value: 'no-store' },
      ]);
    });

    it('caches the landing read for the CDN with no stale window', () => {
      expect(headersOf(StudioLandingController, 'getLanding')).toEqual({
        'Cache-Control': PUBLIC_READ_CACHE,
        'CDN-Cache-Control': NO_STALE_READ_CDN_CACHE,
      });
    });

    it('answers the access request routes without the Studio grant', () => {
      expect(guardsOf(StudioAccessRequestsController)).toEqual([
        ActiveMemberGuard,
      ]);
    });

    it('mounts the landing routes at the contract paths', () => {
      expect(
        ['getLanding', 'getPreviewStream'].map((handler) =>
          routePathOf(StudioLandingController, handler),
        ),
      ).toEqual(['/', 'previews/:previewId/stream']);
      expect(
        ['listPreviews', 'approve', 'decline', 'withdraw'].map((handler) =>
          routePathOf(StudioLandingPreviewsController, handler),
        ),
      ).toEqual([
        ':subprofileId/landing-previews',
        ':subprofileId/landing-previews/:previewId/approve',
        ':subprofileId/landing-previews/:previewId/decline',
        ':subprofileId/landing-previews/:previewId/withdraw',
      ]);
      expect(
        [
          'getLanding',
          'searchTracks',
          'searchPersonas',
          'requestPreview',
          'removePreview',
          'reorderPreviews',
          'createArtistCard',
          'updateArtistCard',
          'deleteArtistCard',
          'reorderArtistCards',
          'putPhoto',
          'deletePhoto',
          'addFoundingArtist',
          'removeFoundingArtist',
          'reorderFoundingArtists',
          'updateSettings',
        ].map((handler) => routePathOf(AdminStudioLandingController, handler)),
      ).toEqual([
        '/',
        'track-search',
        'persona-search',
        'previews',
        'previews/:previewId',
        'previews/reorder',
        'artist-cards',
        'artist-cards/:cardId',
        'artist-cards/:cardId',
        'artist-cards/reorder',
        'photos/:slot',
        'photos/:slot',
        'founding-artists',
        'founding-artists/:foundingArtistId',
        'founding-artists/reorder',
        'settings',
      ]);
      expect(
        ['listWaiting', 'grantRequest', 'dismissRequest'].map((handler) =>
          routePathOf(AdminStudioAccessRequestsController, handler),
        ),
      ).toEqual(['/', ':requestId/grant', ':requestId']);
    });

    it('declares each reorder route before the id route of its list', () => {
      const handlerNames = Object.getOwnPropertyNames(
        AdminStudioLandingController.prototype,
      );
      for (const [reorderHandler, idHandler] of [
        ['reorderPreviews', 'removePreview'],
        ['reorderArtistCards', 'updateArtistCard'],
        ['reorderArtistCards', 'deleteArtistCard'],
        ['reorderFoundingArtists', 'removeFoundingArtist'],
      ] as const) {
        expect(handlerNames.indexOf(reorderHandler)).toBeGreaterThan(-1);
        expect(handlerNames.indexOf(reorderHandler)).toBeLessThan(
          handlerNames.indexOf(idHandler),
        );
      }
    });

    it('names the photo handler putPhoto for the landing key allowlist', () => {
      expect(
        STUDIO_LANDING_SCOPED_KEY_HANDLERS.has(
          `${AdminStudioLandingController.name}.putPhoto`,
        ),
      ).toBe(true);
    });

    it('registers the landing entities, services and listeners', () => {
      expect(
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
      ).toEqual(
        expect.arrayContaining([
          StudioLandingReadService,
          AdminStudioLandingPreviewsService,
          AdminStudioLandingContentService,
          AdminStudioLandingPhotosService,
          StudioLandingPreviewsService,
          StudioAccessRequestsService,
          StudioFoundingArtistsService,
          StudioLandingAlertsListener,
          StudioAccessAlertsListener,
        ]),
      );
    });
  });
});
