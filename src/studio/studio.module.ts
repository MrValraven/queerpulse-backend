import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PreferencesModule } from '../preferences/preferences.module';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { SavedModule } from '../saved/saved.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioCopyrightClaimsController } from './admin-studio-copyright-claims.controller';
import { AdminStudioCurationController } from './admin-studio-curation.controller';
import { AdminStudioCurationService } from './admin-studio-curation.service';
import { AdminStudioDisputesController } from './admin-studio-disputes.controller';
import { AdminStudioReleasesController } from './admin-studio-releases.controller';
import { AdminStudioScenesController } from './admin-studio-scenes.controller';
import { AdminStudioScenesService } from './admin-studio-scenes.service';
import { AdminStudioTracksController } from './admin-studio-tracks.controller';
import { StudioCopyrightClaim } from './entities/studio-copyright-claim.entity';
import { StudioAccessGrant } from './entities/studio-access-grant.entity';
import { StudioCuratedPick } from './entities/studio-curated-pick.entity';
import { StudioPersonaCredit } from './entities/studio-persona-credit.entity';
import { StudioSceneEvent } from './entities/studio-scene-event.entity';
import { StudioScene } from './entities/studio-scene.entity';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import { StudioPlaylistEditor } from './entities/studio-playlist-editor.entity';
import { StudioPlaylistFolderItem } from './entities/studio-playlist-folder-item.entity';
import { StudioPlaylistFolder } from './entities/studio-playlist-folder.entity';
import { StudioPressKit } from './entities/studio-press-kit.entity';
import { StudioReleaseReminder } from './entities/studio-release-reminder.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import { StudioReleaseDispute } from './entities/studio-release-dispute.entity';
import { StudioPlaylist } from './entities/studio-playlist.entity';
import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioAccessService } from './studio-access.service';
import { StudioAdminTracksService } from './studio-admin-tracks.service';
import { StudioAppearsOnService } from './studio-appears-on.service';
import { StudioArtistAppearsOnController } from './studio-artist-appears-on.controller';
import { StudioAudioConfirmService } from './studio-audio-confirm.service';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioClaimsAdminService } from './studio-claims-admin.service';
import { StudioClaimsController } from './studio-claims.controller';
import { StudioClaimsService } from './studio-claims.service';
import { StudioCreditAlertsListener } from './studio-credit-alerts.listener';
import { StudioCreditsInboxController } from './studio-credits-inbox.controller';
import { StudioCreditsInboxService } from './studio-credits-inbox.service';
import { StudioCurationController } from './studio-curation.controller';
import { StudioCurationService } from './studio-curation.service';
import { StudioDisputesService } from './studio-disputes.service';
import { StudioEpisodeAlertsListener } from './studio-episode-alerts.listener';
import { StudioEpisodesController } from './studio-episodes.controller';
import { StudioEpisodesService } from './studio-episodes.service';
import { StudioLikedTracksService } from './studio-liked-tracks.service';
import { StudioListeningController } from './studio-listening.controller';
import { StudioMeController } from './studio-me.controller';
import { StudioModerationService } from './studio-moderation.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioPersonaCreditsController } from './studio-persona-credits.controller';
import { StudioPersonaCreditsService } from './studio-persona-credits.service';
import { StudioPlaybackPreferencesController } from './studio-playback-preferences.controller';
import { StudioPlaylistListingsController } from './studio-playlist-listings.controller';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistWritesService } from './studio-playlist-writes.service';
import { StudioPlaylistEditorBlockListener } from './studio-playlist-editor-block.listener';
import { StudioPlaylistEditorsController } from './studio-playlist-editors.controller';
import { StudioPlaylistEditorsService } from './studio-playlist-editors.service';
import { StudioPlaylistFoldersController } from './studio-playlist-folders.controller';
import { StudioPlaylistFoldersService } from './studio-playlist-folders.service';
import { StudioPlaylistsController } from './studio-playlists.controller';
import { StudioPressKitController } from './studio-press-kit.controller';
import { StudioPressKitService } from './studio-press-kit.service';
import { StudioPreviewsController } from './studio-previews.controller';
import { StudioPreviewsService } from './studio-previews.service';
import { StudioRadioController } from './studio-radio.controller';
import { StudioRadioService } from './studio-radio.service';
import { StudioRelatedArtistsController } from './studio-related-artists.controller';
import { StudioRelatedArtistsService } from './studio-related-artists.service';
import { StudioReleaseAlertsListener } from './studio-release-alerts.listener';
import { StudioReleaseExtrasService } from './studio-release-extras.service';
import { StudioReleaseNoticesListener } from './studio-release-notices.listener';
import { StudioReleaseRemindersService } from './studio-release-reminders.service';
import { StudioReleaseToolsController } from './studio-release-tools.controller';
import { StudioReleaseVersionsService } from './studio-release-versions.service';
import { StudioReleasesController } from './studio-releases.controller';
import { StudioReleasesService } from './studio-releases.service';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';
import { StudioScenesController } from './studio-scenes.controller';
import { StudioScenesService } from './studio-scenes.service';
import { StudioScheduledReleasesService } from './studio-scheduled-releases.service';
import { StudioSchedulingService } from './studio-scheduling.service';
import { StudioStaffReadsService } from './studio-staff-reads.service';
import { StudioStatsController } from './studio-stats.controller';
import { StudioStatsService } from './studio-stats.service';
import { StudioTracksController } from './studio-tracks.controller';
import { StudioTracksService } from './studio-tracks.service';

/**
 * Studio (`QUEERPULSE-STUDIO-V1-DESIGN-2026-10-08.md`, v2
 * `QUEERPULSE-STUDIO-V2-DESIGN-2026-10-13.md`). Shaped like `CinemaModule`.
 * `Subprofile`, `SubprofileMember`, `User` and `Profile` are registered
 * read-only for the ownership, grant and credit checks. `StorageModule`
 * brings the bucket, persona image keys and the Studio audio registry;
 * `SocialModule` the block filter; `ModerationModule` the audit trail;
 * `SubprofilesModule` the follower counts; `NotificationsModule` the
 * new-release fan-out and the takedown notices; `ConnectionsModule` the
 * connections-only playlist check; `PreferencesModule` the player settings
 * (open demo pages). `ModerationModule` also brings
 * `StudioTakedownReportService`. Studio discovery
 * (`QUEERPULSE-STUDIO-DISCOVERY-DESIGN-2026-10-13.md`) adds shelves, scenes,
 * persona credits, related artists and radio on the same imports, plus
 * `UserStaffRole` for the admin guard. None of them imports this module, so
 * the graph stays acyclic. Studio v3
 * (`QUEERPULSE-STUDIO-V3-ARTIST-TOOLS-DESIGN-2026-10-13.md`) adds
 * `SavedModule` for the pre-save; `SavedModule` imports only `SocialModule`,
 * so the graph stays acyclic. `SubprofileSocialLink` is registered read-only
 * for support links and the press kit. Studio artist kinds
 * (QUEERPULSE-STUDIO-ARTIST-KINDS-DESIGN-2026-10-14.md) add the episodes
 * service, its controller and the episode alert listener; no new module
 * import. Liked songs (QUEERPULSE-STUDIO-LIKED-SONGS-PLAN-2026-10-14.md)
 * adds `StudioLikedTracksService` and registers `SavedItem` read-only, so
 * the service reads the caller's own `studio_track` saves. Collaborative
 * playlists (QUEERPULSE-STUDIO-COLLAB-PLAYLISTS-DESIGN-2026-10-14.md) add
 * `StudioPlaylistEditor`, the editors controller and service, and the
 * `MEMBER_BLOCKED` listener that ends editor seats; no new module import.
 * Studio safety and moderation (QUEERPULSE-STUDIO-SAFETY-MODERATION-DESIGN-2026-10-14.md)
 * adds the copyright claims table, the claimant, owner and staff claim
 * routes, the staff track actions and the in-app safety notices, on the
 * existing imports (`ModerationModule` brings `ModAuditService` and
 * `StudioTakedownReportService`, `NotificationsModule` the notices,
 * `Profile` the claimant card).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudioAccessGrant,
      StudioRelease,
      StudioTrack,
      StudioPlaylist,
      StudioPlaylistTrack,
      StudioPlaylistEditor,
      StudioPlaylistFolder,
      StudioPlaylistFolderItem,
      StudioReleaseReminder,
      StudioReleaseVersion,
      StudioPressKit,
      StudioScene,
      StudioSceneEvent,
      StudioCuratedPick,
      StudioPersonaCredit,
      StudioReleaseDispute,
      StudioCopyrightClaim,
      Subprofile,
      SubprofileMember,
      SubprofileSocialLink,
      User,
      Profile,
      // Read-only, for `RolesOrStaffGuard` on the discovery admin
      // controllers, the `AdminTopicsModule` precedent.
      UserStaffRole,
      // Read-only, for Liked songs (`StudioLikedTracksService`).
      SavedItem,
    ]),
    StorageModule,
    SocialModule,
    ModerationModule,
    SubprofilesModule,
    NotificationsModule,
    ConnectionsModule,
    PreferencesModule,
    // Studio v3: `SavedService` for the Notify me pre-save. `SavedModule`
    // imports only `SocialModule`, so the graph stays acyclic.
    SavedModule,
  ],
  controllers: [
    StudioMeController,
    StudioListeningController,
    StudioReleasesController,
    StudioTracksController,
    // Playlist folders before the playlists controller: `GET
    // studio/playlists/folders` must match here, never `GET :id`.
    StudioPlaylistFoldersController,
    StudioPlaylistsController,
    StudioPlaylistEditorsController,
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
    StudioClaimsController,
    AdminStudioAccessController,
    AdminStudioReleasesController,
    AdminStudioDisputesController,
    AdminStudioCurationController,
    AdminStudioScenesController,
    AdminStudioCopyrightClaimsController,
    AdminStudioTracksController,
  ],
  providers: [
    StudioAccessService,
    StudioAccessGuard,
    StudioOwnershipService,
    StudioCatalogService,
    StudioReleasesService,
    StudioTracksService,
    StudioAudioConfirmService,
    StudioModerationService,
    StudioPlaylistReadsService,
    StudioPlaylistWritesService,
    StudioPlaylistFoldersService,
    StudioStatsService,
    StudioReleaseAlertsListener,
    StudioReleaseExtrasService,
    StudioSchedulingService,
    StudioScheduledReleasesService,
    StudioReleaseRemindersService,
    StudioReleaseVersionsService,
    StudioPreviewsService,
    StudioPressKitService,
    StudioDisputesService,
    StudioStaffReadsService,
    StudioReleaseNoticesListener,
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
    // Studio artist kinds.
    StudioEpisodesService,
    StudioEpisodeAlertsListener,
    // Liked songs.
    StudioLikedTracksService,
    // Collaborative playlists.
    StudioPlaylistEditorsService,
    StudioPlaylistEditorBlockListener,
    // Studio safety and moderation.
    StudioClaimsService,
    StudioClaimsAdminService,
    StudioAdminTracksService,
    StudioSafetyNoticesService,
  ],
  // The Admin creator drafts preview (`CreatorDraftsModule`) reads a release
  // as its preview link shows it. That module imports this one; nothing here
  // imports it back.
  exports: [StudioCatalogService],
})
export class StudioModule {}
