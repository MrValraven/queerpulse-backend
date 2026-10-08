import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Notification } from '../notifications/entities/notification.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { ConnectionsModule } from '../connections/connections.module';
import { Listing } from '../listings/entities/listing.entity';
import { Event } from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { MentionNameResolveService } from './mention-name-resolve.service';
import { MentionNotificationService } from './mention-notification.service';
import { MentionsInboxService } from './mentions-inbox.service';
import { MentionsController } from './mentions.controller';

@Module({
  imports: [
    // Exports `NotificationsService`, which every mention fan-out ultimately
    // calls to write + push the `mention` notification.
    NotificationsModule,
    // Entity repos for the read-only lookups: resolving a mentioned entity's
    // steward is a read-only lookup, and injecting each domain's service here
    // would risk circular module deps (e.g. forum -> mentions -> forum).
    // `Notification` is the read side's source of truth: mentions are persisted
    // only as `mention` notifications, so the inbox reads them straight.
    TypeOrmModule.forFeature([
      Notification,
      Community,
      CommunityMember,
      Listing,
      Event,
      ForumThread,
      Profile,
      // Read-only: restricts a `message`-source mention to the conversation's
      // own participants, so a DM excerpt never reaches a non-participant.
      // `MentionNameResolveService` reads the same seats for PRD-423.
      ConversationParticipant,
      // Read-only (PRD-423): whether a conversation is a matched Go together
      // chat, whose members resolve to first names inside it.
      Conversation,
      // Read-only: which candidates hold a platform staff role, so a forum
      // fan-out lets moderators and admins past the publish and community
      // gates the way the forum's own read does.
      User,
      // Read-only: the repositories `EventAudienceGateService` (provided
      // below) reads, so a gathering-description mention reaches only the
      // people the gathering's detail page admits. `MentionNameResolveService`
      // reads `EventCohost` too, for the organiser exemption on a takedown.
      EventCohost,
      EventInvite,
      EventRsvp,
    ]),
    // `BlockFilterService`, so a forum fan-out drops anyone blocked either way
    // with the thread's author. Plain import: nothing `SocialModule` imports,
    // directly or through users, reports, identities and storage, reaches
    // back to this module, and `NotificationsModule` above already imports it.
    SocialModule,
    // `ContentModerationService.stateFor`, so a community fan-out reaches
    // only the staff of a community a moderator hid or removed. A leaf
    // module (its only import is its own entity repo), so no cycle.
    ContentModerationModule,
    // `ConnectionsService` and `CommunityMembershipService`, the two services
    // `EventAudienceGateService` depends on. `EventsModule` imports both
    // already and neither reaches back to this module, so no cycle.
    ConnectionsModule,
    CommunityMembershipModule,
  ],
  controllers: [MentionsController],
  providers: [
    MentionNotificationService,
    // The gathering audience gate, provided here as well as in `EventsModule`.
    // `EventsModule` imports this module (an event description's mentions
    // fan out through `MentionNotificationService`), so importing it back
    // would close a cycle. The gate is stateless (repositories and two
    // stateless services), so a second instance cannot drift from the first:
    // the same precedent as `CardTokenService` in `EventsModule`. Injected by
    // `MentionNotificationService`, `MentionsInboxService` and
    // `MentionNameResolveService` (an `e/slug` tag names only a gathering the
    // viewer could open).
    EventAudienceGateService,
    MentionNameResolveService,
    MentionsInboxService,
  ],
  exports: [MentionNotificationService],
})
export class MentionsModule {}
