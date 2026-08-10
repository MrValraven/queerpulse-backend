import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { EventInvitesController, EventsController } from './events.controller';
import { EventPhotosController } from './event-photos.controller';
import { EventReminderPreferencesController } from './event-reminder-preferences.controller';
import { EventBookmark } from './entities/event-bookmark.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventPhoto } from './entities/event-photo.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { MemberEventReminderPreferences } from './entities/member-event-reminder-preferences.entity';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventInvitesService } from './event-invites.service';
import { EventPhotosService } from './event-photos.service';
import { EventReminderPreferencesService } from './event-reminder-preferences.service';
import { EventRemindersService } from './event-reminders.service';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      EventCohost,
      EventRsvp,
      EventInvite,
      EventLineupEntry,
      EventPhoto,
      EventBookmark,
      MemberEventReminderPreferences,
    ]),
    UsersModule,
    NotificationsModule,
    // `PushService` — event reminders deliver a best-effort phone push on top of
    // the in-app notification. `PushModule` -> {`ChatModule`, `UsersModule`},
    // neither of which imports `EventsModule`, so this closes no cycle.
    PushModule,
    // `BlockFilterService` — attendee lists drop blocked members. Plain
    // import: `SocialModule` -> {`UsersModule`, `ReportsModule`} only, so
    // neither this nor `NotificationsModule`'s own `SocialModule` import
    // closes a cycle back to `EventsModule`.
    SocialModule,
    // `StorageService` — the photo list endpoint presigns each stored key.
    // One-way edge: `StorageModule` imports nothing domain-specific, so this
    // closes no cycle.
    StorageModule,
    // `ContentModerationService` — public event browse/search/detail honour a
    // moderator `hide_content`/`remove_content` takedown.
    ContentModerationModule,
    // `CommunityMembershipService` — an optional `communitySlug` on create
    // resolves to the caller's own roster membership before the event is
    // attached to that community. Read-only module; closes no cycle.
    CommunityMembershipModule,
  ],
  controllers: [
    EventsController,
    EventInvitesController,
    EventPhotosController,
    EventReminderPreferencesController,
  ],
  providers: [
    EventsService,
    EventBookmarksService,
    RsvpService,
    EventInvitesService,
    EventRemindersService,
    EventReminderPreferencesService,
    EventPhotosService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
