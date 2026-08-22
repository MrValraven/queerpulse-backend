import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Event } from '../events/entities/event.entity';
import { CalendarFeedController } from './calendar-feed.controller';
import { CalendarFeedService } from './calendar-feed.service';
import { CalendarFeedTokenService } from './calendar-feed-token.service';
import { CalendarFeedToken } from './entities/calendar-feed-token.entity';

/**
 * "Subscribe to your feed" (MyEvents `CalendarSubscribe`) — a signed, public
 * ICS feed of a member's going/maybe events. Deliberately its own module
 * rather than folded into `EventsModule`: read-only over `Event`/`EventRsvp`
 * (re-registering `TypeOrmModule.forFeature` for the same entities here is
 * fine — TypeORM repositories aren't module-exclusive), so this closes no
 * cycle and doesn't need anything `EventsModule` already provides.
 *
 * Owns `calendar_feed_tokens` (`AddCalendarFeedTokens1793510000000`): the feed
 * credential is now a stored, per-member, revocable random token rather than an
 * HMAC of the member's user id — see `CalendarFeedTokenService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Event, EventRsvp, CalendarFeedToken])],
  controllers: [CalendarFeedController],
  providers: [CalendarFeedService, CalendarFeedTokenService],
})
export class CalendarFeedModule {}
