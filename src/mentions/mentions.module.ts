import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Notification } from '../notifications/entities/notification.entity';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { Profile } from '../users/entities/profile.entity';
import { MentionNotificationService } from './mention-notification.service';
import { MentionsInboxService } from './mentions-inbox.service';
import { MentionsController } from './mentions.controller';

@Module({
  imports: [
    // Exports `NotificationsService`, which every mention fan-out ultimately
    // calls to write + push the `mention` notification.
    NotificationsModule,
    // Entity repos, not sibling services — resolving a mentioned entity's
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
      ConversationParticipant,
    ]),
  ],
  controllers: [MentionsController],
  providers: [MentionNotificationService, MentionsInboxService],
  exports: [MentionNotificationService],
})
export class MentionsModule {}
