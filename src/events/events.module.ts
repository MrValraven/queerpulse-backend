import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { ListingLookupModule } from '../listings/listing-lookup.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { CardTokenService } from '../membership-cards/card-token.service';
import { CommunityCard } from '../membership-cards/entities/community-card.entity';
import { MembershipCard } from '../membership-cards/entities/membership-card.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PushModule } from '../push/push.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import {
  EventCohostInvitesController,
  EventInvitesController,
  EventsController,
} from './events.controller';
import { EventPhotosController } from './event-photos.controller';
import { EventReminderPreferencesController } from './event-reminder-preferences.controller';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventBan } from './entities/event-ban.entity';
import { EventBookmark } from './entities/event-bookmark.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventCohostInvite } from './entities/event-cohost-invite.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventPhoto } from './entities/event-photo.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { EventSeries } from './entities/event-series.entity';
import { Event } from './entities/event.entity';
import { MemberEventReminderPreferences } from './entities/member-event-reminder-preferences.entity';
import { EventAnnouncementsService } from './event-announcements.service';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBansService } from './event-bans.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventCheckInService } from './event-check-in.service';
import { EventCohostInvitesService } from './event-cohost-invites.service';
import { EventInvitesService } from './event-invites.service';
import { EventPhotosService } from './event-photos.service';
import { EventReminderPreferencesService } from './event-reminder-preferences.service';
import { EventAttendanceRetentionService } from './event-attendance-retention.service';
import { EventRemindersService } from './event-reminders.service';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      EventCohost,
      EventCohostInvite,
      EventRsvp,
      EventInvite,
      EventLineupEntry,
      EventPhoto,
      EventBookmark,
      MemberEventReminderPreferences,
      EventSeries,
      // Host announcements (LOC-06) and the host's own door (LOC-08).
      EventAnnouncement,
      EventBan,
      // ── Day-of check-in by scanned membership card (LOC-03) ─────────────
      // These three belong to `MembershipCardsModule`, and they are
      // registered here rather than imported through it because
      // `MembershipCardsModule` imports `CommunitiesModule`, which imports
      // THIS module: importing it back would close a dependency cycle.
      // `TypeOrmModule.forFeature` on another module's entity is the
      // established way out (`AdminCommunitiesModule` reads `Community` the
      // same way), and `EventCheckInService` reuses the SHARED pure
      // `effectiveCardStatus` rather than restating the status rules.
      MembershipCard,
      CommunityCard,
      Community,
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
    // `ConnectionsService` — backs the `network`/`extended_network` audience
    // scope: `assertCanView`'s connections/mutual-connection gate and the
    // browse/search queries' viewer-connection-ids OR-in predicate.
    // `ConnectionsModule` -> {`UsersModule`, `SocialModule`, `VouchModule`},
    // none of which import `EventsModule`, so this closes no cycle (no
    // `forwardRef` needed).
    ConnectionsModule,
    // Batched crop lookup (`MediaCropService.getMany`) for `coverImageUrl`/a
    // gathering photo's `crop` sibling, shared by `EventsService` and
    // `EventPhotosService`.
    MediaCropsModule,
    // `ListingLookupService` — an optional `listingId` on create/update
    // resolves+validates against a real, live directory listing before the
    // event's venue is linked to it. Read-only module; closes no cycle.
    ListingLookupModule,
  ],
  controllers: [
    EventsController,
    EventInvitesController,
    EventCohostInvitesController,
    EventPhotosController,
    EventReminderPreferencesController,
  ],
  providers: [
    EventsService,
    EventBookmarksService,
    RsvpService,
    EventInvitesService,
    EventCohostInvitesService,
    EventRemindersService,
    // Daily cron clearing attendance detail on gatherings that ended over the
    // retention window ago. Needs no controller and is exported to nobody: it
    // only ever runs on its own schedule.
    EventAttendanceRetentionService,
    EventReminderPreferencesService,
    EventPhotosService,
    EventAnnouncementsService,
    EventBansService,
    EventCheckInService,
    // Verifies a scanned membership-card QR at an event door (LOC-03).
    // Provided here, not imported, for the cycle reason spelled out on the
    // `forFeature` list above. It is a stateless verifier over an Ed25519 key
    // pair read from config, so a second instance holds no state of its own
    // and cannot drift from the one `MembershipCardsModule` provides.
    CardTokenService,
    // Shared audience-scope tier check `EventsService.assertCanView` (reads)
    // and `RsvpService` (writes) both call — a leaf provider (depends only on
    // `ConnectionsService`/`CommunityMembershipService` and its own
    // `EventInvite`/`EventRsvp` repos), so injecting it into BOTH avoids the
    // circular dependency a direct `RsvpService` -> `EventsService` edge
    // would create (`EventsService` already injects `RsvpService`).
    EventAudienceGateService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
