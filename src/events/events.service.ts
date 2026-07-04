import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { In, Repository } from 'typeorm';
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
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';

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

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
  ) {}

  async create(hostId: string, dto: CreateEventInput): Promise<EventDetail> {
    const slug = await this.generateUniqueSlug(dto.title);
    const event = this.events.create({
      hostId,
      slug,
      title: dto.title,
      description: dto.description,
      startAt: new Date(dto.startAt),
      endAt: dto.endAt ? new Date(dto.endAt) : null,
      timezone: dto.timezone,
      venue: dto.venue ?? null,
      isOnline: dto.isOnline ?? false,
      onlineUrl: dto.onlineUrl ?? null,
      capacity: dto.capacity ?? null,
      visibility: dto.visibility ?? EventVisibility.Public,
      status: dto.status ?? EventStatus.Published,
      coverImageUrl: dto.coverImageUrl ?? null,
    });
    const saved = await this.events.save(event);
    return this.buildDetail(saved, hostId);
  }

  async getBySlug(slug: string, viewerId: string): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    return this.buildDetail(event, viewerId);
  }

  async update(
    slug: string,
    userId: string,
    dto: UpdateEventInput,
  ): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);
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
    const saved = await this.events.save(event);
    return this.buildDetail(saved, userId);
  }

  async cancel(slug: string, userId: string): Promise<EventDetail> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, userId);
    event.status = EventStatus.Cancelled;
    const saved = await this.events.save(event);
    return this.buildDetail(saved, userId);
  }

  async list(
    userId: string,
    filter: EventListFilter,
    page: number,
  ): Promise<EventSummary[]> {
    const now = new Date();
    let events: Event[] = [];

    if (filter === 'hosting') {
      const cohosted = await this.cohosts.find({ where: { userId } });
      const ids = cohosted.map((c) => c.eventId);
      events = await this.events.find({
        where: [{ hostId: userId }, ...(ids.length ? [{ id: In(ids) }] : [])],
        order: { startAt: 'DESC' },
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      });
    } else if (filter === 'going' || filter === 'waitlisted') {
      const status =
        filter === 'going' ? RsvpStatus.Going : RsvpStatus.Waitlisted;
      const myRsvps = await this.rsvps.find({ where: { userId, status } });
      const ids = myRsvps.map((r) => r.eventId);
      events = ids.length
        ? await this.events.find({
            where: { id: In(ids) },
            order: { startAt: 'ASC' },
          })
        : [];
    } else if (filter === 'past') {
      const myRsvps = await this.rsvps.find({ where: { userId } });
      const ids = myRsvps.map((r) => r.eventId);
      events = ids.length
        ? (
            await this.events.find({
              where: { id: In(ids) },
              order: { startAt: 'DESC' },
            })
          ).filter((e) => e.startAt.getTime() < now.getTime())
        : [];
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
        .skip((page - 1) * PAGE_SIZE)
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
    const exists = await this.cohosts.exists({
      where: { eventId: event.id, userId: profile.userId },
    });
    if (!exists && profile.userId !== event.hostId) {
      await this.cohosts.save(
        this.cohosts.create({ eventId: event.id, userId: profile.userId }),
      );
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

  async attendees(slug: string, _viewerId: string): Promise<AttendeeView[]> {
    const event = await this.loadEventOr404(slug);
    const rsvps = await this.rsvps.find({
      where: { eventId: event.id },
      order: { status: 'ASC', waitlistPosition: 'ASC' },
    });
    const visible = rsvps.filter((r) => r.status !== RsvpStatus.Cancelled);
    const profiles = await this.profilesByUserIds(visible.map((r) => r.userId));
    return visible.map((r) => toAttendeeView(r, profiles.get(r.userId)));
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
    return Promise.all(
      events.map(async (e) => {
        const goingCount = await this.rsvps.count({
          where: { eventId: e.id, status: RsvpStatus.Going },
        });
        const myRsvp = await this.rsvps.findOne({
          where: { eventId: e.id, userId },
        });
        return toEventSummary(e, goingCount, myRsvp ?? null);
      }),
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
