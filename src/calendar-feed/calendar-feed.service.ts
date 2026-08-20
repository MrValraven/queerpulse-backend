import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import { Event, EventStatus } from '../events/entities/event.entity';

/** RFC 5545 text escaping: backslash, semicolon, comma, then newlines —
 *  mirrors the FE's own `escapeText` (`myEvents.ics.ts`) so both ICS
 *  producers in this codebase agree on the same escaping. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** `Date` -> the RFC 5545 UTC "basic format" timestamp (`YYYYMMDDTHHMMSSZ`).
 *  Always UTC (unlike the FE's client-side export, which emits floating local
 *  time) — a server-generated feed has no single "local" timezone to assume,
 *  since the subscribing calendar app could be anywhere. */
function toICSDateUTC(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// A gathering with no explicit end time still needs a bounded calendar block —
// two hours is a reasonable default for a supper club / mixer / meetup, and
// matches how long a typical unbounded gathering actually runs.
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class CalendarFeedService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    private readonly configService: ConfigService,
  ) {}

  /** Builds the member's feed as an RFC 5545 `VCALENDAR` string: every
   *  published event they're going to or maybe attending, soonest first. Past
   *  events stay on the feed too (a calendar app's own view handles "past"),
   *  matching what a real calendar subscription would show. */
  async buildFeed(userId: string): Promise<string> {
    const rsvps = await this.rsvps.find({
      where: { userId, status: In([RsvpStatus.Going, RsvpStatus.Maybe]) },
    });
    if (rsvps.length === 0) {
      return this.wrap([]);
    }
    const events = await this.events.find({
      where: {
        id: In(rsvps.map((rsvp) => rsvp.eventId)),
        status: EventStatus.Published,
      },
      order: { startAt: 'ASC' },
    });
    return this.wrap(events);
  }

  private wrap(events: Event[]): string {
    const frontendUrl = this.configService.get<string>('app.frontendUrl');
    const now = toICSDateUTC(new Date());
    const lines: string[] = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//QueerPulse//Calendar Feed//EN',
      'CALSCALE:GREGORIAN',
      // Hints most calendar clients honour for a periodically-refreshed feed
      // (Google Calendar / Apple Calendar both re-poll a webcal-style URL on
      // their own schedule regardless, but these are the standard hints).
      'X-WR-CALNAME:QueerPulse',
      'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    ];
    for (const event of events) {
      const start = event.startAt;
      const end = event.endAt ?? new Date(start.getTime() + DEFAULT_DURATION_MS);
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${event.id}@queerpulse.app`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART:${toICSDateUTC(start)}`);
      lines.push(`DTEND:${toICSDateUTC(end)}`);
      lines.push(`SUMMARY:${escapeText(event.title)}`);
      const location = event.isOnline ? 'Online' : (event.venue ?? '');
      if (location) lines.push(`LOCATION:${escapeText(location)}`);
      if (frontendUrl) {
        // Mirrors the reminder push's own deep link (`event-reminders.service.ts`).
        lines.push(`URL:${frontendUrl}/events/${event.slug}`);
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }
}
