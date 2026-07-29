import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile } from '../users/entities/profile.entity';
import { MentionNotificationService } from './mention-notification.service';

@Module({
  imports: [
    // Exports `NotificationsService`, which every mention fan-out ultimately
    // calls to write + push the `mention` notification.
    NotificationsModule,
    // Entity repos, not sibling services — resolving a mentioned entity's
    // steward is a read-only lookup, and injecting each domain's service here
    // would risk circular module deps (e.g. forum -> mentions -> forum).
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      Listing,
      Event,
      ForumThread,
      Profile,
    ]),
  ],
  providers: [MentionNotificationService],
  exports: [MentionNotificationService],
})
export class MentionsModule {}
