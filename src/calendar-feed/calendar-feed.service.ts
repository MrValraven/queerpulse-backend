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

// RFC 5545 §3.1: no content line may exceed 75 OCTETS, excluding the CRLF.
// Longer lines are split, with each continuation starting with a single space
// that the parser strips back out. The space counts toward the 75, hence 74
// octets of payload per continuation.
const MAX_CONTENT_LINE_OCTETS = 75;

/**
 * Folds one content line to RFC 5545's 75-octet limit.
 *
 * Measured in UTF-8 OCTETS, not characters, and never split mid-character: a
 * gathering titled with an emoji or a Portuguese accent would otherwise be cut
 * through the middle of a multi-byte sequence and arrive as mojibake. Titles
 * run to 200 characters and venues to 300 (`CreateEventDto`), so unfolded
 * `SUMMARY:`/`LOCATION:` lines routinely broke the limit and strict parsers
 * truncated or dropped the whole event.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_CONTENT_LINE_OCTETS) {
    return line;
  }
  const folded: string[] = [];
  let current = '';
  let currentOctets = 0;
  // The first line gets the full 75; every continuation spends one octet on
  // its leading space.
  let budget = MAX_CONTENT_LINE_OCTETS;
  // Iterating the string yields whole code points, so a surrogate pair stays
  // intact; the octet count then keeps whole UTF-8 sequences intact too.
  for (const character of line) {
    const characterOctets = encoder.encode(character).length;
    if (currentOctets + characterOctets > budget) {
      folded.push(current);
      current = '';
      currentOctets = 0;
      budget = MAX_CONTENT_LINE_OCTETS - 1;
    }
    current += character;
    currentOctets += characterOctets;
  }
  folded.push(current);
  return folded
    .map((part, index) => (index === 0 ? part : ` ${part}`))
    .join('\r\n');
}

/** `Date` -> the RFC 5545 UTC "basic format" timestamp (`YYYYMMDDTHHMMSSZ`).
 *  Always UTC (unlike the FE's client-side export, which emits floating local
 *  time) — a server-generated feed has no single "local" timezone to assume,
 *  since the subscribing calendar app could be anywhere. */
function toICSDateUTC(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
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
      const end =
        event.endAt ?? new Date(start.getTime() + DEFAULT_DURATION_MS);
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
    // Fold at the join, so every line the feed emits is bounded regardless of
    // which branch above pushed it.
    return lines.map(foldLine).join('\r\n');
  }
}
