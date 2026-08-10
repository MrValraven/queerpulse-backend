import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { normalizePage, paginate } from '../common/pagination';
import { randomBytes } from 'node:crypto';
import { In, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AttendeeStatusFilter } from './dto/list-attendees.query';
import {
  AttendeesPageDTO,
  EventDetail,
  EventLineupDTO,
  EventSummary,
  toAttendeeView,
  toEventSummary,
  toLineupEntryView,
  toOrganizerView,
} from './event-response';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import { RsvpService } from './rsvp.service';

export interface LineupEntryInput {
  memberSlug: string;
  role: string;
}

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
  communitySlug?: string;
}

export type UpdateEventInput = Partial<CreateEventInput>;
export type EventListFilter =
  'upcoming' | 'going' | 'hosting' | 'waitlisted' | 'past' | 'saved';

const PAGE_SIZE = 20;

// Generous cap on a single "who performed" lineup — mirrors
// `ReplaceAffiliationsDTO`'s `ArrayMaxSize` shape (validated again here so a
// caller can't route around the DTO cap by calling the service directly).
const MAX_LINEUP_ENTRIES = 50;

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on the
// QueryFailedError or on the wrapped driverError depending on the path.
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
    @InjectRepository(EventLineupEntry)
    private readonly lineupEntries: Repository<EventLineupEntry>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly usersService: UsersService,
    private readonly rsvpService: RsvpService,
    private readonly notifications: NotificationsService,
    private readonly blockFilter: BlockFilterService,
    private readonly contentModeration: ContentModerationService,
    private readonly membership: CommunityMembershipService,
    private readonly bookmarks: EventBookmarksService,
  ) {}

  // Events are reported (and taken down) under the `event` taxonomy code, keyed
  // by the event's uuid.
  private static readonly SUBJECT_TYPE = 'event';

  // Excludes moderator-taken-down events from a browse/search query, in-query so
  // pagination and any `take` limit stay consistent. Applied to the PUBLIC
  // discovery surfaces only (`upcoming` browse + global search); an organizer
  // still reaches a taken-down event through their hosting context and the
  // detail gate (`assertCanView`) admits them.
  private excludeModeratedEvents(qb: SelectQueryBuilder<Event>): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = :eventSubjectType
          AND "cm"."subject_id" = e.id::text
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )`,
      { eventSubjectType: EventsService.SUBJECT_TYPE },
    );
  }

  async create(hostId: string, dto: CreateEventInput): Promise<EventDetail> {
    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : null;
    this.assertScheduleValid(startAt, endAt, { rejectPast: true });

    let communityId: string | null = null;
    if (dto.communitySlug) {
      communityId = await this.membership.assertMemberBySlug(
        dto.communitySlug,
        hostId,
      );
    }

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
      communityId,
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
    // Snapshot the material fields (when + where) before the patch so we can
    // tell afterwards whether the edit is worth notifying attendees about.
    const oldVenue = event.venue;
    const oldIsOnline = event.isOnline;
    const oldOnlineUrl = event.onlineUrl;

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

    // Material change → tell the people counting on this event. "Material" is
    // when (start time) or where (venue / online flag / online URL) — the two
    // things a member plans around. Trivial edits (title, description, cover,
    // capacity, visibility) deliberately do NOT notify: this is a "you need to
    // re-plan" signal, not a changelog, so it stays low-noise. Only published
    // events fan out — a draft is the organizers' private workspace, and a
    // cancelled event already got its own EventCancelled notice.
    const materialChanges: string[] = [];
    if (saved.startAt.getTime() !== oldStartAt.getTime()) {
      materialChanges.push('startAt');
    }
    if (
      saved.venue !== oldVenue ||
      saved.isOnline !== oldIsOnline ||
      saved.onlineUrl !== oldOnlineUrl
    ) {
      materialChanges.push('location');
    }
    if (materialChanges.length > 0 && saved.status === EventStatus.Published) {
      await this.notifyEventUpdated(saved, userId, materialChanges);
    }

    return this.buildDetail(saved, userId);
  }

  /**
   * Fan an `EventUpdated` notification out to everyone with a stake in the
   * event — a live RSVP (going/maybe/waitlisted) or a standing invite — minus
   * the organizer who made the edit. Recipients are de-duplicated so a member
   * who is both invited and RSVP'd gets exactly one row per update (no spam),
   * mirroring the `EventCancelled` fan-out in `cancel()`.
   */
  private async notifyEventUpdated(
    event: Event,
    editorId: string,
    changes: string[],
  ): Promise<void> {
    const [rsvps, invites] = await Promise.all([
      this.rsvps.find({
        where: {
          eventId: event.id,
          status: In([
            RsvpStatus.Going,
            RsvpStatus.Maybe,
            RsvpStatus.Waitlisted,
          ]),
        },
      }),
      this.invites.find({ where: { eventId: event.id } }),
    ]);
    const recipientIds = [
      ...new Set([
        ...rsvps.map((rsvp) => rsvp.userId),
        ...invites.map((invite) => invite.inviteeId),
      ]),
    ].filter((recipientId) => recipientId !== editorId);
    if (recipientIds.length === 0) return;
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.EventUpdated,
      {
        eventId: event.id,
        // Carried so the MyEvents "What's changed" panel can deep-link the row
        // to the event card (the client keys events by slug, not uuid).
        eventSlug: event.slug,
        title: event.title,
        startAt: event.startAt.toISOString(),
        changes,
      },
    );
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
        // Carried so the MyEvents panel can deep-link the row (client keys by slug).
        eventSlug: saved.slug,
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
    let events: Event[];

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
        // Property path (`startAt`), not the DB column: with the join + skip/take
        // this goes through TypeORM's distinct-id pagination pass, which resolves
        // ORDER BY via `findColumnWithPropertyPath` and throws on a raw column.
        .orderBy('e.startAt', 'ASC')
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
          statuses: [RsvpStatus.Going, RsvpStatus.Maybe, RsvpStatus.Waitlisted],
        })
        .andWhere('e.start_at < :now', { now })
        // Property path (`startAt`) — see the join+pagination note above.
        .orderBy('e.startAt', 'DESC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    } else if (filter === 'saved') {
      // The member's bookmarked ("saved") events, most-recently-saved first.
      // One indexed join over `event_bookmarks`, paginated — the same shape as
      // the `going`/`waitlisted` branches above. (Was an honest empty stub until
      // the `event_bookmarks` entity landed — see BE-3.)
      events = await this.bookmarks.listSaved(userId, skip, PAGE_SIZE);
    } else {
      // 'upcoming' — published, future, public/members (invite_only surfaces
      // via going/hosting/invited contexts, not the general browse).
      const upcomingQb = this.events
        .createQueryBuilder('e')
        .where('e.status = :status', { status: EventStatus.Published })
        .andWhere('e.start_at >= :now', { now })
        .andWhere('e.visibility IN (:...vis)', {
          vis: [EventVisibility.Public, EventVisibility.Members],
        });
      this.excludeModeratedEvents(upcomingQb);
      events = await upcomingQb
        .orderBy('e.start_at', 'ASC')
        .skip(skip)
        .take(PAGE_SIZE)
        .getMany();
    }

    return this.summarize(events, userId);
  }

  // Cross-entity global search (SearchService) — mirrors the 'upcoming'
  // branch's visibility (published, public/members) but drops the
  // `start_at >= now` restriction so past matches still surface. ILIKE over
  // title / venue / description.
  async searchByText(
    userId: string,
    term: string,
    limit: number,
  ): Promise<EventSummary[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const searchQb = this.events
      .createQueryBuilder('e')
      .where('e.status = :status', { status: EventStatus.Published })
      .andWhere('e.visibility IN (:...vis)', {
        vis: [EventVisibility.Public, EventVisibility.Members],
      })
      .andWhere(
        '(e.title ILIKE :pattern OR e.venue ILIKE :pattern OR e.description ILIKE :pattern)',
        { pattern },
      );
    this.excludeModeratedEvents(searchQb);
    const events = await searchQb
      .orderBy('e.start_at', 'DESC')
      .take(limit)
      .getMany();

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

  /**
   * Host/co-host-only replace-all of an event's lineup ("who performed").
   * Mirrors `SubprofilesService.replaceAffiliations`'s shape: resolve +
   * validate every target BEFORE writing anything (batched, one `IN` query,
   * not a `findOne` per entry), then delete-and-recreate inside one
   * transaction so a caller never observes a partially-replaced lineup.
   * Duplicate `memberSlug`s in the same call collapse to one row (last role
   * wins) rather than tripping the `UNIQUE(event_id, user_id)` constraint.
   */
  async replaceLineup(
    slug: string,
    actorId: string,
    entries: LineupEntryInput[],
  ): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertOrganizer(event.id, actorId);

    if (entries.length > MAX_LINEUP_ENTRIES) {
      throw new BadRequestException(
        `A lineup can have at most ${MAX_LINEUP_ENTRIES} entries`,
      );
    }

    const memberSlugs = [...new Set(entries.map((entry) => entry.memberSlug))];
    const profiles = memberSlugs.length
      ? await this.profiles.find({ where: { slug: In(memberSlugs) } })
      : [];
    const profileBySlug = new Map(profiles.map((p) => [p.slug, p]));

    for (const entry of entries) {
      if (!profileBySlug.has(entry.memberSlug)) {
        throw new NotFoundException(`Member not found: ${entry.memberSlug}`);
      }
    }

    const rowsByUserId = new Map<string, { userId: string; role: string }>();
    for (const entry of entries) {
      const profile = profileBySlug.get(entry.memberSlug);
      if (!profile) continue; // unreachable — validated above
      rowsByUserId.set(profile.userId, {
        userId: profile.userId,
        role: entry.role,
      });
    }

    await this.lineupEntries.manager.transaction(async (manager) => {
      await manager.delete(EventLineupEntry, { eventId: event.id });
      const rows = [...rowsByUserId.values()].map((row) =>
        manager.create(EventLineupEntry, {
          eventId: event.id,
          userId: row.userId,
          role: row.role,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });

    return this.buildLineupDTO(event.id, actorId);
  }

  // Same visibility gate as `attendees` — a draft/invite-only/taken-down
  // event 404s for a non-organizer viewer rather than leaking its lineup.
  async getLineup(slug: string, viewerId: string): Promise<EventLineupDTO> {
    const event = await this.loadEventOr404(slug);
    await this.assertCanView(event, viewerId);
    return this.buildLineupDTO(event.id, viewerId);
  }

  private async buildLineupDTO(
    eventId: string,
    viewerId: string,
  ): Promise<EventLineupDTO> {
    const rows = await this.lineupEntries.find({
      where: { eventId },
      order: { createdAt: 'ASC' },
    });
    const profiles = await this.profilesByUserIds(rows.map((r) => r.userId));
    const entries = rows
      .map((row) => toLineupEntryView(row, profiles.get(row.userId)))
      .filter((view): view is NonNullable<typeof view> => view !== null);
    const viewerRow = rows.find((row) => row.userId === viewerId);
    const viewerEntry = viewerRow
      ? toLineupEntryView(viewerRow, profiles.get(viewerRow.userId))
      : null;
    return { entries, viewerEntry };
  }

  /**
   * One RSVP status's own paginated page (`going` or `waitlisted`) — never
   * the whole guest list in one response. This used to be
   * `this.rsvps.find({ where: { eventId } })` with no `LIMIT` at all: an
   * uncapped (`capacity: null`) public gathering could accumulate an
   * unbounded number of `going` rows, all fetched (and post-query filtered)
   * on every dashboard load. `status` splits the single combined list into
   * the two the manage dashboard actually renders, and `paginate` bounds each
   * to `PAGE_SIZE` per page.
   */
  async attendees(
    slug: string,
    viewerId: string,
    status: AttendeeStatusFilter,
    page?: number,
  ): Promise<AttendeesPageDTO> {
    const event = await this.loadEventOr404(slug);
    const isOrganizer = await this.assertCanView(event, viewerId);
    const normalizedPage = normalizePage(page);
    const rsvpStatus =
      status === 'waitlisted' ? RsvpStatus.Waitlisted : RsvpStatus.Going;

    const qb = this.rsvps
      .createQueryBuilder('r')
      .where('r.event_id = :eventId', { eventId: event.id })
      .andWhere('r.status = :status', { status: rsvpStatus })
      .orderBy('r.waitlist_position', 'ASC')
      .addOrderBy('r.created_at', 'ASC');
    // Blocks only — deliberately NOT mutes. A block is a mutual severance, so
    // a blocked member must not surface in a list the viewer reads (same rule
    // `ProfilesService.searchMembers` applies to the directory). A mute is a
    // content-feed silence, not an "erase them from the guest list" tool:
    // dropping muted members here would misstate who is actually attending,
    // which the viewer may need to know for their own safety planning.
    // In-query (not the old post-query filter) so a page of `PAGE_SIZE`
    // attendees comes back full instead of silently short.
    this.blockFilter.excludeBlocked(qb, viewerId, '"r"."user_id"');

    const {
      items,
      total,
      page: resolvedPage,
      pageSize,
    } = await paginate(qb, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      const profiles = await this.profilesByUserIds(rows.map((r) => r.userId));
      return rows
        .filter((r) => profiles.has(r.userId)) // drop profile-less ghost rows
        .map((r) => {
          const view = toAttendeeView(r, profiles.get(r.userId));
          // Waitlist ordering is organizer-only; hide positions from regular viewers.
          if (!isOrganizer) {
            view.waitlistPosition = null;
          }
          return view;
        });
    });

    return {
      items,
      total,
      page: resolvedPage,
      pageSize,
      capacity: event.capacity,
    };
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
    // A moderator takedown 404s the detail for everyone but an organizer — same
    // "don't leak existence" posture as the draft/invite-only gates below.
    if (!isOrganizer) {
      const moderation = await this.contentModeration.stateFor(
        EventsService.SUBJECT_TYPE,
        event.id,
      );
      if (moderation.hidden || moderation.removed) {
        throw new NotFoundException('Event not found');
      }
    }
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

    // ...and one IN-query for which of the page's events the viewer bookmarked.
    const bookmarkedIds = await this.bookmarks.bookmarkedEventIds(
      userId,
      eventIds,
    );

    return events.map((e) =>
      toEventSummary(
        e,
        goingByEvent.get(e.id) ?? 0,
        myRsvpByEvent.get(e.id) ?? null,
        bookmarkedIds.has(e.id),
      ),
    );
  }

  private async buildDetail(
    event: Event,
    viewerId: string,
  ): Promise<EventDetail> {
    // First wave: these five lookups are all independent of one another — only
    // `profilesByUserIds` below depends on `cohostRows`'s ids, so it waits for
    // its own second wave instead of chaining behind every other await.
    const [goingCount, waitlistCount, myRsvp, cohostRows, isBookmarked] =
      await Promise.all([
        this.rsvps.count({
          where: { eventId: event.id, status: RsvpStatus.Going },
        }),
        this.rsvps.count({
          where: { eventId: event.id, status: RsvpStatus.Waitlisted },
        }),
        this.rsvps.findOne({
          where: { eventId: event.id, userId: viewerId },
        }),
        this.cohosts.find({
          where: { eventId: event.id },
        }),
        this.bookmarks.isBookmarked(viewerId, event.id),
      ]);
    const organizerIds = [event.hostId, ...cohostRows.map((c) => c.userId)];
    const profiles = await this.profilesByUserIds(organizerIds);
    const isOrganizer =
      event.hostId === viewerId ||
      cohostRows.some((c) => c.userId === viewerId);

    const summary = toEventSummary(
      event,
      goingCount,
      myRsvp ?? null,
      isBookmarked,
    );
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
