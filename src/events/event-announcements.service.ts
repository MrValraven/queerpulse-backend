import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  EventAnnouncementView,
  toEventAnnouncementView,
} from './event-response';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';

/**
 * LOC-06 — a host reaching the people who are coming.
 *
 * "Message attendees" existed as a modal whose send handler set a local
 * boolean and drew a panel saying it had gone to N people. There was no
 * request behind it, and live mode hid the button entirely, which was honest
 * and left a real host with no way to say "we moved to the back room" or
 * "here is the door code".
 *
 * The recipient set is the SAME one `EventsService.notifyEventUpdated`
 * resolves: everyone holding a live RSVP (going, maybe or waitlisted) plus
 * everyone holding a standing invite, de-duplicated, minus the organiser who
 * pressed send. That query was already the right answer to "who has a stake
 * in this gathering"; this reuses it rather than inventing a second one that
 * could drift.
 *
 * DELIVERY IS IN-APP PLUS PUSH, and nothing else. QueerPulse sends no email
 * and never will, so no copy in this file, on this route, or about this
 * feature may describe a send.
 */
@Injectable()
export class EventAnnouncementsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(EventAnnouncement)
    private readonly announcements: Repository<EventAnnouncement>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `POST /events/:slug/announcements` — host and co-host only, rate-limited
   * at the controller.
   *
   * Writes the row FIRST and fans out afterwards: the record of what the host
   * said is the durable thing, and a notification failure must never lose it.
   */
  async create(
    slug: string,
    actorId: string,
    body: string,
  ): Promise<EventAnnouncementView> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event, actorId);

    const trimmed = body.trim();
    if (!trimmed) {
      throw new BadRequestException('Write something to send');
    }

    const recipientIds = await this.resolveRecipients(event.id, actorId);
    const saved = await this.announcements.save(
      this.announcements.create({
        eventId: event.id,
        authorId: actorId,
        body: trimmed,
        recipientCount: recipientIds.length,
      }),
    );

    if (recipientIds.length > 0) {
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.EventAnnouncement,
        {
          eventId: event.id,
          // The client keys events by slug, so the deep link needs it.
          eventSlug: event.slug,
          title: event.title,
          announcementId: saved.id,
          // The host's own words ride along deliberately. Every recipient is
          // somebody the host addressed on purpose and every one of them can
          // read the same text on the event page, so withholding it from the
          // bell would only make "the door code is 4471" arrive as "a host
          // said something". The body is capped at
          // `MAX_EVENT_ANNOUNCEMENT_LENGTH` and is plain text.
          body: trimmed,
          // The actor, so block/mute filtering applies like any other
          // member-driven type.
          actorId,
        },
        actorId,
      );
    }

    const author = await this.profiles.findOne({ where: { userId: actorId } });
    return toEventAnnouncementView(saved, author ?? undefined);
  }

  /**
   * `GET /events/:slug/announcements` — newest first.
   *
   * Readable by an organiser (so a host can see what they already sent) and
   * by anyone holding a live RSVP or a standing invite (so an attendee can
   * find the door code again at the door). A passer-by gets a 403 rather than
   * a silently empty list, so the frontend never renders "no announcements"
   * at somebody who simply has not RSVPed.
   */
  async list(slug: string, viewerId: string): Promise<EventAnnouncementView[]> {
    const event = await this.loadEventOr404(slug);
    const isOrganizer = await this.isOrganizer(event, viewerId);
    if (!isOrganizer && !(await this.hasStake(event.id, viewerId))) {
      throw new ForbiddenException(
        'Only the organisers and the people coming can read these',
      );
    }

    const rows = await this.announcements.find({
      where: { eventId: event.id },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];
    const authorIds = [
      ...new Set(rows.flatMap((row) => (row.authorId ? [row.authorId] : []))),
    ];
    const authors = authorIds.length
      ? await this.profiles.find({ where: { userId: In(authorIds) } })
      : [];
    const authorByUserId = new Map(
      authors.map((profile) => [profile.userId, profile]),
    );
    return rows.map((row) =>
      toEventAnnouncementView(
        row,
        row.authorId ? authorByUserId.get(row.authorId) : undefined,
      ),
    );
  }

  // --- internals ---

  /** The identical recipient resolution `EventsService.notifyEventUpdated`
   *  performs: live RSVPs plus standing invites, de-duplicated, minus the
   *  organiser who is sending. */
  private async resolveRecipients(
    eventId: string,
    actorId: string,
  ): Promise<string[]> {
    const [rsvps, invites] = await Promise.all([
      this.rsvps.find({
        where: {
          eventId,
          status: In([
            RsvpStatus.Going,
            RsvpStatus.Maybe,
            RsvpStatus.Waitlisted,
          ]),
        },
      }),
      this.invites.find({ where: { eventId } }),
    ]);
    return [
      ...new Set([
        ...rsvps.map((rsvp) => rsvp.userId),
        ...invites.map((invite) => invite.inviteeId),
      ]),
    ].filter((recipientId) => recipientId !== actorId);
  }

  private async hasStake(eventId: string, userId: string): Promise<boolean> {
    const hasLiveRsvp = await this.rsvps.exists({
      where: {
        eventId,
        userId,
        status: In([RsvpStatus.Going, RsvpStatus.Maybe, RsvpStatus.Waitlisted]),
      },
    });
    if (hasLiveRsvp) return true;
    return this.invites.exists({ where: { eventId, inviteeId: userId } });
  }

  private async isOrganizer(event: Event, userId: string): Promise<boolean> {
    if (event.hostId === userId) return true;
    return this.cohosts.exists({ where: { eventId: event.id, userId } });
  }

  private async assertOrganizer(event: Event, userId: string): Promise<void> {
    if (!(await this.isOrganizer(event, userId))) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  private async loadEventOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }
}
