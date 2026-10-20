import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { Community } from '../communities/entities/community.entity';
import { ListingDraft } from '../listing-drafts/entities/listing-draft.entity';
import { ListingCoManager } from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { ModerationModule } from '../moderation/moderation.module';
import { StudioRelease } from '../studio/entities/studio-release.entity';
import { StudioTrack } from '../studio/entities/studio-track.entity';
import { StudioModule } from '../studio/studio.module';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminCreatorDraftRowsService } from './admin-creator-draft-rows.service';
import { AdminCreatorDraftsController } from './admin-creator-drafts.controller';
import { AdminCreatorDraftsService } from './admin-creator-drafts.service';
import { CreatorDraftMadeForService } from './creator-draft-made-for.service';
import { CreatorDraftRetentionService } from './creator-draft-retention.service';
import {
  CREATOR_DRAFT_VISIBILITY,
  DEFAULT_CREATOR_DRAFT_VISIBILITY,
} from './creator-drafts.constants';
import { CreatorDraftsController } from './creator-drafts.controller';
import { CreatorDraftsService } from './creator-drafts.service';
import { CreatorDraft } from './entities/creator-draft.entity';

/**
 * Creator drafts: the author's own routes at `me/creator-drafts` and the
 * Admin read-only view at `admin/creator-drafts`.
 *
 * Imports:
 * - `CommunityMembershipModule` exports `CommunityMembershipService`, which
 *   `CreatorDraftMadeForService` uses to keep a community only when the
 *   author is on its roster.
 * - `ModerationModule` exports `ModAuditService`, the writer of the
 *   `creator_draft_viewed` row on every Admin detail read.
 * - `SubprofilesModule` exports `SubprofilePublicReadService`, the persona
 *   staff preview.
 * - `StudioModule` exports `StudioCatalogService`, the release and episode
 *   staff preview.
 * - `ScheduleModule.forRoot()` is registered app-wide in `AppModule`, so the
 *   retention cron is a plain provider. `ConfigModule` is global.
 *
 * Cycle check: `CreatorDraftsModule` is imported by `AppModule` alone; none
 * of `CommunityMembershipModule`, `ModerationModule`, `SubprofilesModule` or
 * `StudioModule` imports it. `CreatorDraftSlotsModule` imports only its
 * `forFeature`, so `EventsModule` and `CommunitiesModule` gain no edge back.
 * `ModerationModule`'s graph (`ReportsModule`, `UsersModule`, `AuthModule`,
 * `ContentModerationModule`, `NotificationsModule`,
 * `CommunityMembershipModule`, `AdminQueueNotificationsModule`,
 * `IdentitiesModule`) never reaches `ListingDraftsModule`. No `forwardRef`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CreatorDraft,
      ListingDraft,
      Subprofile,
      StudioRelease,
      StudioTrack,
      Community,
      Listing,
      ListingCoManager,
      Profile,
    ]),
    CommunityMembershipModule,
    ModerationModule,
    SubprofilesModule,
    StudioModule,
  ],
  controllers: [CreatorDraftsController, AdminCreatorDraftsController],
  providers: [
    CreatorDraftsService,
    CreatorDraftMadeForService,
    AdminCreatorDraftRowsService,
    AdminCreatorDraftsService,
    CreatorDraftRetentionService,
    {
      provide: CREATOR_DRAFT_VISIBILITY,
      useValue: DEFAULT_CREATOR_DRAFT_VISIBILITY,
    },
  ],
})
export class CreatorDraftsModule {}
