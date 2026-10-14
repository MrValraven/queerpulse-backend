import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { SubprofileFollower } from '../subprofiles/entities/subprofile-follower.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { AdminPersonaPostsController } from './admin-persona-posts.controller';
import { SubprofilePostQuotaEntry } from './entities/subprofile-post-quota-entry.entity';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { PersonaPostAlertsService } from './persona-post-alerts.service';
import { PersonaPostEditsController } from './persona-post-edits.controller';
import { PersonaPostsController } from './persona-posts.controller';
import { SubprofilePostModerationService } from './subprofile-post-moderation.service';
import { SubprofilePostsService } from './subprofile-posts.service';

/**
 * Studio v3 persona posts (`QUEERPULSE-STUDIO-V3-ARTIST-TOOLS-DESIGN-2026-10-13.md`,
 * phase F), in a module of their own so the subprofiles module stays as it
 * is. `SubprofilesModule` brings `SubprofilePublicReadService` (the
 * `/p/<handle>` read rule), `StorageModule` the persona image keys,
 * `NotificationsModule` the fan-out, `ContentModerationModule` the takedown
 * check and `ModerationModule` the audit trail. None of them imports this
 * module, so the graph stays acyclic. `Subprofile`, `SubprofileMember` and
 * `SubprofileFollower` are registered read-only for the lock, the roster and
 * the follower read.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubprofilePost,
      SubprofilePostQuotaEntry,
      Subprofile,
      SubprofileMember,
      SubprofileFollower,
    ]),
    SubprofilesModule,
    StorageModule,
    NotificationsModule,
    ContentModerationModule,
    ModerationModule,
  ],
  controllers: [
    PersonaPostsController,
    PersonaPostEditsController,
    AdminPersonaPostsController,
  ],
  providers: [
    SubprofilePostsService,
    PersonaPostAlertsService,
    SubprofilePostModerationService,
  ],
})
export class SubprofilePostsModule {}
