import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioReleasesController } from './admin-studio-releases.controller';
import { StudioAccessGrant } from './entities/studio-access-grant.entity';
import { StudioPlaylistTrack } from './entities/studio-playlist-track.entity';
import { StudioPlaylist } from './entities/studio-playlist.entity';
import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioAccessService } from './studio-access.service';
import { StudioAudioConfirmService } from './studio-audio-confirm.service';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioListeningController } from './studio-listening.controller';
import { StudioMeController } from './studio-me.controller';
import { StudioModerationService } from './studio-moderation.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { StudioPlaylistListingsController } from './studio-playlist-listings.controller';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistWritesService } from './studio-playlist-writes.service';
import { StudioPlaylistsController } from './studio-playlists.controller';
import { StudioReleaseAlertsListener } from './studio-release-alerts.listener';
import { StudioReleasesController } from './studio-releases.controller';
import { StudioReleasesService } from './studio-releases.service';
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
 * new-release fan-out; `ConnectionsModule` the connections-only playlist
 * check. None of them imports this module, so the graph stays acyclic.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudioAccessGrant,
      StudioRelease,
      StudioTrack,
      StudioPlaylist,
      StudioPlaylistTrack,
      Subprofile,
      SubprofileMember,
      User,
      Profile,
    ]),
    StorageModule,
    SocialModule,
    ModerationModule,
    SubprofilesModule,
    NotificationsModule,
    ConnectionsModule,
  ],
  controllers: [
    StudioMeController,
    StudioListeningController,
    StudioReleasesController,
    StudioTracksController,
    StudioPlaylistsController,
    StudioPlaylistListingsController,
    StudioStatsController,
    AdminStudioAccessController,
    AdminStudioReleasesController,
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
    StudioStatsService,
    StudioReleaseAlertsListener,
  ],
})
export class StudioModule {}
