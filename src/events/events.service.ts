import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { In, Not, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  AttendeeView,
  EventDetail,
  EventSummary,
  toAttendeeView,
  toEventSummary,
  toOrganizerView,
} from './event-response';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

export interface CreateEventInput {
  title: string;
  description: string;
  startAt: string;
  endAt?: string;
  timezone: string;
  venue?: string;
  isOnline?: boolean;
  onlineUrl?: string;
  capacity?: number;
  visibility?: EventVisibility;
  status?: EventStatus.Draft | EventStatus.Published;
  coverImageUrl?: string;
}

export type UpdateEventInput = Partial<CreateEventInput>;
export type EventListFilter =
  'upcoming' | 'going' | 'hosting' | 'waitlisted' | 'past' | 'saved';

const PAGE_SIZE = 20;

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on the
// QueryFailedError or on the wrapped driverError depending on the path.
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

// null capacity means unlimited. "Increased" = strictly more seats than before:
// a bigger number, or a number lifted to unlimited. Shrinking never promotes.
function capacityIncreased(
  oldCapacity: number | null,
  newCapacity: number | null,
): boolean {
  if (oldCapacity === null) return false; // already unlimited — nothing to free
  if (newCapacity === null) return true; // finite → unlimited
  return newCapacity > oldCapacity;
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly rsvpService: RsvpService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(hostId: string, dto: CreateEventInput): Promise<EventDetail> {
    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : null;
    this.assertScheduleValid(startAt, endAt, { rejectPast: true });

    const event = this.events.create({
      hostId,
      slug: '', // assigned (race-safely) by saveWithUniqueSlug
      title: dto.title,
      description: dto.description,
      startAt,
      endAt,
      timezone: dto.timezone,
      venue: dto.venue ?? null,
      isOnline: dto.isOnline ?? false,
      onlineUrl: dto.onlineUrl ?? null,
      capacity: dto.capacity ?? null,
      visibility: dto.visibility ?? EventVisibility.Public,
      status: dto.status ?? EventStatus.Published,
      coverImageUrl: dto.coverImageUrl ?? null,
    });
    const saved = await this.saveWithUniqueSlug(event, dto.title);
    return this.buildDetail(saved, hostId);
  }

  async getBySlug(slug: string, viewerId: string): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertCanView(event, viewerId);
    return this.buildDetail(event, viewerId);
  }

  async update(
    slug: string,
    userId: string,
    dto: UpdateEventInput,
  ): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);

    // A cancelled event is terminal: cancel() is the only way in and there is no
    // way back out. The update DTO only allows Draft | Published for status, so
    // any provided status is a reopen attempt and must be rejected.
    if (event.status === EventStatus.Cancelled && dto.status !== undefined) {
      throw new ConflictException('A cancelled event cannot be reopened');
    }

    const oldStartAt = event.startAt;
    const oldCapacity = event.capacity;

    // Validate the resulting schedule (effective start/end after the patch).
    const nextStartAt =
      dto.startAt !== undefined ? new Date(dto.startAt) : event.startAt;
    const nextEndAt =
      dto.endAt !== undefined
        ? dto.endAt
          ? new Date(dto.endAt)
          : null
        : event.endAt;
    this.assertScheduleValid(nextStartAt, nextEndAt, { rejectPast: false });

    Object.assign(event, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.startAt !== undefined ? { startAt: new Date(dto.startAt) } : {}),
      ...(dto.endAt !== undefined
        ? { endAt: dto.endAt ? new Date(dto.endAt) : null }
        : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      ...(dto.venue !== undefined ? { venue: dto.venue ?? null } : {}),
      ...(dto.isOnline !== undefined ? { isOnline: dto.isOnline } : {}),
      ...(dto.onlineUrl !== undefined
        ? { onlineUrl: dto.onlineUrl ?? null }
        : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity ?? null } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.coverImageUrl !== undefined
        ? { coverImageUrl: dto.coverImageUrl ?? null }
        : {}),
    });

    // Pushing the start later makes an already-sent reminder premature — re-arm
    // it so the cron fires again against the new time.
    if (
      dto.startAt !== undefined &&
      event.startAt.getTime() > oldStartAt.getTime()
    ) {
      event.reminderSentAt = null;
    }

    const saved = await this.events.save(event);

    // Growing capacity (or lifting it entirely) can free seats — pull the
    // waitlist head(s) up. Skip on non-published events (nothing to admit into).
    if (
      saved.status === EventStatus.Published &&
      capacityIncreased(oldCapacity, saved.capacity)
    ) {
      await this.rsvpService.reconcileWaitlist(saved.slug);
    }

    return this.buildDetail(saved, userId);
  }

  async cancel(slug: string, userId: string): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);
    event.status = EventStatus.Cancelled;
    const saved = await this.events.save(event);
    // Tell attendees the event is off. Fan out AFTER the status is persisted;
    // mirrors EventRemindersService. Recipients = anyone with a live RSVP
    // (going/maybe/waitlisted), minus the organizer who just cancelled it.
    const rsvps = await this.rsvps.find({
      where: {
        eventId: saved.id,
        status: In([RsvpStatus.Going, RsvpStatus.Maybe, RsvpStatus.Waitlisted]),
      },
    });
    const recipientIds = rsvps
      .map((r) => r.userId)
      .filter((id) => id !== userId);
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.EventCancelled,
      {
        eventId: saved.id,
        title: saved.title,
        startAt: saved.startAt.toISOString(),
      },
    );
    return this.buildDetail(saved, userId);
  }

  async list(
    userId: string,
    filter: EventListFilter,
    page: number,
  ): Promise<EventSummary[]> {
    const now = new Date();
    const skip = (page - 1) * PAGE_SIZE;
    let events: Event[] = [];

    if (filter === 'hosting') {
      const cohosted = await this.cohosts.find({ where: { userId } });
      const ids = cohosted.map((c) => c.eventId);
      events = await this.events.find({
        where: [{ hostId: userId }, ...(ids.length ? [{ id: In(ids) }] : [])],
        order: { startAt: 'DESC' },
        take: PAGE_SIZE,
        skip,
      });
    } else if (filter === 'going' || filter === 'waitlisted') {
      // One join instead of "fetch my rsvp ids, then fetch events". Paginated.
      const status =
        filter === 'going' ? RsvpStatus.Going : RsvpStatus.Waitlisted;
      events = await this.events
        .createQueryBuilder('e')
        .innerJoin(EventRsvp, 'r', 'r.event_id = e.id')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.status = :status', { status })
        .orderBy('e.start_at', 'ASC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    } else if (filter === 'past') {
      // Single join: my non-cancelled RSVPs to events that have already started.
      events = await this.events
        .createQueryBuilder('e')
        .innerJoin(EventRsvp, 'r', 'r.event_id = e.id')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.status IN (:...statuses)', {
          statuses: [
            RsvpStatus.Going,
            RsvpStatus.Maybe,
            RsvpStatus.Waitlisted,
          ],
        })
        .andWhere('e.start_at < :now', { now })
        .orderBy('e.start_at', 'DESC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    } else if (filter === 'saved') {
      // No bookmark entity in the MVP data model — empty for now.
      events = [];
    } else {
      // 'upcoming' — published, future, public/members (invite_only surfaces
      // via going/hosting/invited contexts, not the general browse).
      events = await this.events
        .createQueryBuilder('e')
        .where('e.status = :status', { status: EventStatus.Published })
        .andWhere('e.start_at >= :now', { now })
        .andWhere('e.visibility IN (:...vis)', {
          vis: [EventVisibility.Public, EventVisibility.Members],
        })
        .orderBy('e.start_at', 'ASC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    }

    return this.summarize(events, userId);
  }

  async addCohost(
    slug: string,
    actorId: string,
    cohostSlug: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.profiles.findOne({
      where: { slug: cohostSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    const cohostUser = await this.usersService.findById(profile.userId);
    if (!cohostUser || cohostUser.status !== UserStatus.Active) {
      throw new BadRequestException('Co-hosts must be active members');
    }
    // The host is implicitly an organizer — no cohost row needed. For everyone
    // else, insert idempotently: ON CONFLICT DO NOTHING absorbs the race between
    // two concurrent add requests without a pre-check + 23505.
    if (profile.userId !== event.hostId) {
      await this.cohosts
        .createQueryBuilder()
        .insert()
        .into(EventCohost)
        .values({ eventId: event.id, userId: profile.userId })
        .orIgnore()
        .execute();
    }
    return { ok: true };
  }

  async removeCohost(
    slug: string,
    actorId: string,
    cohostSlug: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);
    const profile = await this.profiles.findOne({
      where: { slug: cohostSlug },
    });
    if (profile) {
      await this.cohosts.delete({
        eventId: event.id,
        userId: profile.userId,
      });
    }
    return { ok: true };
  }

  async attendees(slug: string, viewerId: string): Promise<AttendeeView[]> {
    const event = await this.loadEventOr404(slug);
    const isOrganizer = await this.assertCanView(event, viewerId);
    const rsvps = await this.rsvps.find({
      where: { eventId: event.id },
      order: { status: 'ASC', waitlistPosition: 'ASC' },
    });
    const visible = rsvps.filter((r) => r.status !== RsvpStatus.Cancelled);
    const profiles = await this.profilesByUserIds(visible.map((r) => r.userId));
    return visible
      .filter((r) => profiles.has(r.userId)) // drop profile-less ghost rows
      .map((r) => {
        const view = toAttendeeView(r, profiles.get(r.userId));
        // Waitlist ordering is organizer-only; hide positions from regular viewers.
        if (!isOrganizer) {
          view.waitlistPosition = null;
        }
        return view;
      });
  }

  async isOrganizer(eventId: string, userId: string): Promise<boolean> {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) return false;
    if (event.hostId === userId) return true;
    return this.cohosts.exists({ where: { eventId, userId } });
  }

  // --- internals ---

  private async assertOrganizer(
    eventId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.isOrganizer(eventId, userId))) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  // Enforces read visibility and returns whether the viewer is an organizer (so
  // callers can reuse the fact without a second lookup). Non-viewable events are
  // reported as 404 rather than 403 so their existence isn't leaked.
  private async assertCanView(
    event: Event,
    viewerId: string,
  ): Promise<boolean> {
    const isOrganizer = await this.isOrganizer(event.id, viewerId);
    // Drafts are the organizers' private workspace — invisible to everyone else.
    if (event.status === EventStatus.Draft) {
      if (!isOrganizer) {
        throw new NotFoundException('Event not found');
      }
      return isOrganizer;
    }
    // Invite-only events (including their join URL) are visible only to
    // organizers, invited members, and anyone who has already RSVP'd.
    if (event.visibility === EventVisibility.InviteOnly && !isOrganizer) {
      const [invited, rsvped] = await Promise.all([
        this.invites.exists({
          where: { eventId: event.id, inviteeId: viewerId },
        }),
        this.rsvps.exists({
          where: {
            eventId: event.id,
            userId: viewerId,
            status: Not(RsvpStatus.Cancelled),
          },
        }),
      ]);
      if (!invited && !rsvped) {
        throw new NotFoundException('Event not found');
      }
    }
    return isOrganizer;
  }

  private assertScheduleValid(
    startAt: Date,
    endAt: Date | null,
    opts: { rejectPast: boolean },
  ): void {
    if (opts.rejectPast && startAt.getTime() < Date.now()) {
      throw new BadRequestException('startAt must be in the future');
    }
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException('endAt must be after startAt');
    }
  }

  private async loadEventOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async summarize(
    events: Event[],
    userId: string,
  ): Promise<EventSummary[]> {
    if (!events.length) return [];
    const eventIds = events.map((e) => e.id);

    // One grouped count for every event's going tally...
    const goingRows = await this.rsvps
      .createQueryBuilder('r')
      .select('r.event_id', 'eventId')
      .addSelect('COUNT(*)', 'count')
      .where('r.event_id IN (:...ids)', { ids: eventIds })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .groupBy('r.event_id')
      .getRawMany<{ eventId: string; count: string }>();
    const goingByEvent = new Map(
      goingRows.map((row) => [row.eventId, Number(row.count)]),
    );

    // ...and one IN-query for the viewer's own RSVP across the whole page.
    const myRsvps = await this.rsvps.find({
      where: { eventId: In(eventIds), userId },
    });
    const myRsvpByEvent = new Map(myRsvps.map((r) => [r.eventId, r]));

    return events.map((e) =>
      toEventSummary(
        e,
        goingByEvent.get(e.id) ?? 0,
        myRsvpByEvent.get(e.id) ?? null,
      ),
    );
  }

  private async buildDetail(
    event: Event,
    viewerId: string,
  ): Promise<EventDetail> {
    const goingCount = await this.rsvps.count({
      where: { eventId: event.id, status: RsvpStatus.Going },
    });
    const waitlistCount = await this.rsvps.count({
      where: { eventId: event.id, status: RsvpStatus.Waitlisted },
    });
    const myRsvp = await this.rsvps.findOne({
      where: { eventId: event.id, userId: viewerId },
    });
    const cohostRows = await this.cohosts.find({
      where: { eventId: event.id },
    });
    const organizerIds = [event.hostId, ...cohostRows.map((c) => c.userId)];
    const profiles = await this.profilesByUserIds(organizerIds);
    const isOrganizer =
      event.hostId === viewerId ||
      cohostRows.some((c) => c.userId === viewerId);

    const summary = toEventSummary(event, goingCount, myRsvp ?? null);
    return {
      ...summary,
      description: event.description,
      onlineUrl: event.onlineUrl,
      host: toOrganizerView(profiles.get(event.hostId)),
      cohosts: cohostRows
        .map((c) => toOrganizerView(profiles.get(c.userId)))
        .filter((v): v is NonNullable<typeof v> => v !== null),
      isOrganizer,
      waitlistCount,
      myWaitlistPosition: myRsvp?.waitlistPosition ?? null,
    };
  }

  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) return new Map();
    const found = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(found.map((p) => [p.userId, p]));
  }

  // Assigns a unique slug and persists, retrying on the (rare) race where a
  // concurrent create grabs the same slug between the pre-check and this INSERT.
  private async saveWithUniqueSlug(
    event: Event,
    title: string,
  ): Promise<Event> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      event.slug = await this.generateUniqueSlug(title);
      try {
        return await this.events.save(event);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) {
          continue; // lost the slug race — regenerate and retry
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved event or rethrows.
    throw new ConflictException('Could not allocate a unique event slug');
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    const base =
      title
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'event';
    let slug = base;
    while (await this.events.exists({ where: { slug } })) {
      slug = `${base}-${randomBytes(3).toString('hex')}`;
    }
    return slug;
  }
}
