import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { Event } from '../events/entities/event.entity';
import { Handle } from '../handles/entities/handle.entity';
import { HandlesModule } from '../handles/handles.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { SubprofileInvite } from './entities/subprofile-invite.entity';
import { SubprofileItem } from './entities/subprofile-item.entity';
import { SubprofileItemRevision } from './entities/subprofile-item-revision.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import {
  ProfileSubprofilesController,
  SubprofilesController,
} from './subprofiles.controller';
import { SubprofileItemRevisionsController } from './subprofile-item-revisions.controller';
import { SubprofileCreditsService } from './subprofile-credits.service';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileInvitesService } from './subprofile-invites.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';
import { SubprofilesService } from './subprofiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subprofile,
      SubprofileAffiliation,
      SubprofileEndorsement,
      SubprofileFollower,
      SubprofileInvite,
      SubprofileItem,
      SubprofileItemRevision,
      SubprofileMember,
      SubprofileSocialLink,
      Event,
      Community,
      Handle,
    ]),
    // Exports the `Profile` repository (used to resolve an owner slug → user).
    UsersModule,
    // Exports `BlockFilterService`, used to hide blocked-either-way members
    // from the directory and by-handle lookups (design spec §4).
    SocialModule,
    // Exports `HandlesService` — publish/unpublish/link-switch/handle-change now
    // claim/release the persona's name in the ONE global namespace (Task C2).
    HandlesModule,
    // Read-only: public persona reads (profile-nested / by-handle / directory /
    // search / sitemap) withhold a moderator-taken-down persona (keyed by slug).
    ContentModerationModule,
    // `NotificationsService` — `replaceSection` emits `subprofile_credit` when
    // a save newly credits a member's @handle (Personas discovery Phase 5,
    // Moment 6). Plain import, no `forwardRef`: `NotificationsModule`
    // deliberately reaches `SubprofileMember` via a bare repo (see its own
    // module comment) instead of importing `SubprofilesModule`, so this edge
    // is one-directional and there is no cycle to break.
    NotificationsModule,
  ],
  controllers: [
    SubprofilesController,
    ProfileSubprofilesController,
    // Protect Your Work (revision history), Task 8: list/get/restore an
    // item's saved revisions.
    SubprofileItemRevisionsController,
  ],
  providers: [
    SubprofilesService,
    SubprofileMembershipService,
    SubprofileCreditsService,
    SubprofilePublicReadService,
    SubprofileEndorsementsService,
    SubprofileFollowersService,
    SubprofileInvitesService,
  ],
  // Exported for the cross-entity SearchModule (standalone-persona search).
  // `SubprofileEndorsementsService` is also exported: `PublicEligibilityModule`
  // reads endorsement counts for the caller's public-profile eligibility signals.
  exports: [SubprofilesService, SubprofileEndorsementsService],
})
export class SubprofilesModule {}
