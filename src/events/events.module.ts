import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { EventInvitesController, EventsController } from './events.controller';
import { EventPhotosController } from './event-photos.controller';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventPhoto } from './entities/event-photo.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventInvitesService } from './event-invites.service';
import { EventPhotosService } from './event-photos.service';
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
      EventPhoto,
    ]),
    UsersModule,
    NotificationsModule,
    // `BlockFilterService` — attendee lists drop blocked members. Plain
    // import: `SocialModule` -> {`UsersModule`, `ReportsModule`} only, so
    // neither this nor `NotificationsModule`'s own `SocialModule` import
    // closes a cycle back to `EventsModule`.
    SocialModule,
    // `StorageService` — the photo list endpoint presigns each stored key.
    // One-way edge: `StorageModule` imports nothing domain-specific, so this
    // closes no cycle.
    StorageModule,
  ],
  controllers: [
    EventsController,
    EventInvitesController,
    EventPhotosController,
  ],
  providers: [
    EventsService,
    RsvpService,
    EventInvitesService,
    EventRemindersService,
    EventPhotosService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
