import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModerationModule } from '../moderation/moderation.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { User } from '../users/entities/user.entity';
import { AdminStudioAccessController } from './admin-studio-access.controller';
import { AdminStudioReleasesController } from './admin-studio-releases.controller';
import { StudioAccessGrant } from './entities/studio-access-grant.entity';
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
import { StudioReleasesController } from './studio-releases.controller';
import { StudioReleasesService } from './studio-releases.service';
import { StudioTracksController } from './studio-tracks.controller';
import { StudioTracksService } from './studio-tracks.service';

/**
 * Studio v1 (`QUEERPULSE-STUDIO-V1-DESIGN-2026-10-08.md`). Shaped like
 * `CinemaModule`. `Subprofile`, `SubprofileMember` and `User` are registered
 * read-only for the ownership and grant checks, the same move other modules
 * make in place of importing `SubprofilesModule`. `StorageModule` brings the
 * bucket, persona image keys and the Studio audio registry; `SocialModule`
 * the block filter; `ModerationModule` the audit trail. None of them imports
 * this module, so the graph stays acyclic.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StudioAccessGrant,
      StudioRelease,
      StudioTrack,
      Subprofile,
      SubprofileMember,
      User,
    ]),
    StorageModule,
    SocialModule,
    ModerationModule,
  ],
  controllers: [
    StudioMeController,
    StudioListeningController,
    StudioReleasesController,
    StudioTracksController,
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
  ],
})
export class StudioModule {}
