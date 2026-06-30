import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { EventInvitesController, EventsController } from './events.controller';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventInvitesService } from './event-invites.service';
import { EventRemindersService } from './event-reminders.service';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event, EventCohost, EventRsvp, EventInvite]),
    UsersModule,
    NotificationsModule,
  ],
  controllers: [EventsController, EventInvitesController],
  providers: [EventsService, RsvpService, EventInvitesService, EventRemindersService],
  exports: [EventsService],
})
export class EventsModule {}
