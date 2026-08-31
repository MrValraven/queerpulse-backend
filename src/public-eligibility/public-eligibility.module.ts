import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { Event } from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { PublicEligibilityController } from './public-eligibility.controller';
import { PublicEligibilityService } from './public-eligibility.service';

/**
 * `MagazineArticle`/`MagazineDeck` are deliberately NOT registered here: the
 * service only reaches them via raw `leftJoin(Entity, ...)` calls on the
 * `MagazinePiece` query builder (joined by class, no injected repository), and
 * TypeORM entity metadata is loaded globally (via `autoLoadEntities`), not
 * per-module — `MagazineModule` already registers both. `forFeature` here
 * would just add unused repository providers.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Profile,
      MagazinePiece,
      Event,
      EventCohost,
      EventRsvp,
      Subprofile,
      ForumThread,
      ForumPost,
      CommunityPost,
      CommunityPostReply,
      // Roster rows, for the XP-side "does anybody else stand in this room?"
      // counts on the service. A repository only: this module never calls into
      // `CommunitiesModule`, so no dependency (and no cycle) is created.
      CommunityMember,
      Vouch,
    ]),
    // Exports `ConnectionsService` (connection counts).
    ConnectionsModule,
    // Exports `SubprofileEndorsementsService` (endorsement counts), added to
    // this module's `exports` as part of this task — it previously exported
    // only `SubprofilesService`.
    SubprofilesModule,
    // Exports `ContentModerationService` (moderation/standing state).
    ContentModerationModule,
  ],
  controllers: [PublicEligibilityController],
  providers: [PublicEligibilityService],
  exports: [PublicEligibilityService],
})
export class PublicEligibilityModule {}
