import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, MoreThan, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import type { UpdateRsvpDetailsDto } from './dto/update-rsvp-details.dto';
import {
  EVENT_RSVPED,
  EVENT_WAITLIST_PROMOTED,
  EventRsvpedEvent,
  EventWaitlistPromotedEvent,
} from './event.events';
import { RsvpDetailsView, toRsvpDetailsView } from './event-response';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

// Raw row shape from the unlimited-capacity promotion UPDATE's RETURNING
// clause — column names are the actual (snake_case) DB columns, not the
// entity's camelCase.
interface PromotedRsvpRow {
  user_id: string;
}

@Injectable()
export class RsvpService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly audienceGate: EventAudienceGateService,
    // Resolves a host/co-host's target-member `slug` (what the manage-
    // attendees UI has) to the `userId` an `EventRsvp` row is keyed by — see
    // `removeAttendee`/`promoteAttendee`. `UsersModule` (imported by
    // `EventsModule`) exports `TypeOrmModule`, so this repository is already
    // in scope with no module change.
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Plain (non-transactional) repos for `updateRsvpDetails` below — that
    // path never touches capacity/waitlist ordering, so it doesn't need the
    // `pessimistic_write` event lock every other write in this service takes.
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
  ) {}

  async rsvp(
    slug: string,
    userId: string,
    status: 'going' | 'maybe',
  ): Promise<{ status: RsvpStatus; waitlistPosition: number | null }> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      if (event.status !== EventStatus.Published) {
        throw new BadRequestException('Event is not open for RSVPs');
      }
      await this.assertMayRsvp(manager, event, userId);

      const rsvpRepo = manager.getRepository(EventRsvp);
      const existing = await rsvpRepo.findOne({
        where: { eventId: event.id, userId },
      });

      // Notify the host only on a member's *first* RSVP to this event (no row
      // yet, or a previously cancelled one being revived) — never on a
      // going↔maybe toggle of a live row, which would spam the host. A host
      // RSVPing to their own event notifies no one.
      const notifyHost =
        event.hostId !== userId &&
        (!existing || existing.status === RsvpStatus.Cancelled);
      const hostRsvp = {
        notifyHost,
        hostId: event.hostId,
        eventSlug: event.slug,
        // Carried through `outcome` so the post-commit EVENT_RSVPED emit can
        // title + visibility-gate the profile activity row (see event.events.ts).
        eventTitle: event.title,
        eventVisibility: event.visibility,
      };

      if (status === 'maybe') {
        // Stepping down from 'going' to 'maybe' frees a seat — pull the waitlist
        // up just as a cancellation would.
        const wasGoing = existing?.status === RsvpStatus.Going;
        await this.persistRsvp(rsvpRepo, existing, event.id, userId, {
          status: RsvpStatus.Maybe,
          waitlistPosition: null,
        });
        const promoted = wasGoing
          ? await this.promoteWaitlist(manager, event)
          : [];
        return {
          result: { status: RsvpStatus.Maybe, waitlistPosition: null },
          eventId: event.id,
          promoted,
          ...hostRsvp,
        };
      }

      // 'going' — apply capacity → waitlist.
      const goingCount = await rsvpRepo.count({
        where: { eventId: event.id, status: RsvpStatus.Going },
      });
      // An existing 'going' row for this user shouldn't count against capacity.
      const alreadyGoing = existing?.status === RsvpStatus.Going;
      const effectiveGoing = alreadyGoing ? goingCount - 1 : goingCount;

      let resolved: RsvpStatus;
      let waitlistPosition: number | null = null;

      if (event.capacity !== null && effectiveGoing >= event.capacity) {
        // Full. A re-RSVP by someone already waitlisted keeps their spot — never
        // send them to the back of the line for pressing the button again.
        if (existing?.status === RsvpStatus.Waitlisted) {
          return {
            result: {
              status: RsvpStatus.Waitlisted,
              waitlistPosition: existing.waitlistPosition,
            },
            eventId: event.id,
            promoted: [] as string[],
            // Already waitlisted — `notifyHost` is already false here (existing
            // row), so re-pressing the button never re-notifies the host.
            ...hostRsvp,
          };
        }
        // The host turned off the manage-dashboard "Allow waitlist" toggle
        // (`Event.allowWaitlist`) — a full event stays full rather than
        // silently enqueueing someone the host doesn't want to run a
        // waitlist for. Strictly `=== false` (not falsy): a row loaded before
        // this column existed, or a test/mock fixture that never sets it,
        // must keep the historical "always waitlist" behavior rather than
        // silently start rejecting.
        if (event.allowWaitlist === false) {
          throw new BadRequestException('This event is full');
        }
        resolved = RsvpStatus.Waitlisted;
        const maxPos = await rsvpRepo
          .createQueryBuilder('r')
          .select('MAX(r.waitlist_position)', 'max')
          .where('r.event_id = :id AND r.status = :s', {
            id: event.id,
            s: RsvpStatus.Waitlisted,
          })
          .getRawOne<{ max: number | null }>();
        waitlistPosition = (maxPos?.max ?? 0) + 1;
      } else {
        resolved = RsvpStatus.Going;
      }

      await this.persistRsvp(rsvpRepo, existing, event.id, userId, {
        status: resolved,
        waitlistPosition,
      });
      return {
        result: { status: resolved, waitlistPosition },
        eventId: event.id,
        promoted: [] as string[],
        ...hostRsvp,
      };
    });

    this.emitPromotions(outcome.eventId, outcome.eventSlug, outcome.promoted);
    // After commit (a mid-transaction emit would survive a rollback): tell the
    // host someone RSVPed. Fire-and-forget on the same bus as the waitlist
    // promotions above; the listener writes + pushes the notification.
    if (outcome.notifyHost) {
      this.eventEmitter.emit(EVENT_RSVPED, {
        eventId: outcome.eventId,
        eventSlug: outcome.eventSlug,
        hostId: outcome.hostId,
        rsvperId: userId,
        eventTitle: outcome.eventTitle,
        eventVisibility: outcome.eventVisibility,
      } satisfies EventRsvpedEvent);
    }
    return outcome.result;
  }

  /**
   * `scope` (MSG-10) — for an occurrence that belongs to a series, `'future'`
   * also cancels the CALLER'S OWN RSVP (never anyone else's) on every later
   * occurrence in the series, exactly mirroring the demo prototype's
   * "leave whole series" choice (`SeriesScopeModal`, queerpulse FE) with a
   * real backend behind it. `'this'` (the default) is unchanged prior
   * behavior — cancels only this one event's RSVP.
   */
  async cancelRsvp(
    slug: string,
    userId: string,
    scope: 'this' | 'future' = 'this',
  ): Promise<{ ok: true }> {
    const primary = await this.cancelRsvpOne(slug, userId);
    if (scope === 'future' && primary.seriesId && primary.seriesIndex !== null) {
      const siblings = await this.events.find({
        where: {
          seriesId: primary.seriesId,
          seriesIndex: MoreThan(primary.seriesIndex),
        },
      });
      for (const sibling of siblings) {
        await this.cancelRsvpOne(sibling.slug, userId);
      }
    }
    return { ok: true };
  }

  // The actual single-event RSVP cancel — everything `cancelRsvp()` did
  // before MSG-10 added series scope, plus the event's own series linkage so
  // the public method above can find later siblings without a second lookup.
  private async cancelRsvpOne(
    slug: string,
    userId: string,
  ): Promise<{ seriesId: string | null; seriesIndex: number | null }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) {
        throw new NotFoundException('Event not found');
      }

      const rsvpRepo = manager.getRepository(EventRsvp);
      const mine = await rsvpRepo.findOne({
        where: { eventId: event.id, userId },
      });
      if (!mine || mine.status === RsvpStatus.Cancelled) {
        return {
          eventId: event.id,
          eventSlug: event.slug,
          promoted: [] as string[],
          seriesId: event.seriesId,
          seriesIndex: event.seriesIndex,
        };
      }
      const wasGoing = mine.status === RsvpStatus.Going;
      mine.status = RsvpStatus.Cancelled;
      mine.waitlistPosition = null;
      await rsvpRepo.save(mine);

      // A freed 'going' seat pulls the head(s) of the waitlist up.
      const promoted = wasGoing
        ? await this.promoteWaitlist(manager, event)
        : [];
      return {
        eventId: event.id,
        eventSlug: event.slug,
        promoted,
        seriesId: event.seriesId,
        seriesIndex: event.seriesIndex,
      };
    });

    this.emitPromotions(result.eventId, result.eventSlug, result.promoted);
    return { seriesId: result.seriesId, seriesIndex: result.seriesIndex };
  }

  // Re-runs waitlist promotion for an event out of band — e.g. after its
  // capacity is increased. Own transaction + row lock so it composes safely with
  // concurrent RSVP mutations.
  async reconcileWaitlist(slug: string): Promise<void> {
    const result = await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) {
        return null;
      }
      const promoted = await this.promoteWaitlist(manager, event);
      return promoted.length
        ? { eventId: event.id, eventSlug: event.slug, promoted }
        : null;
    });
    if (result) {
      this.emitPromotions(result.eventId, result.eventSlug, result.promoted);
    }
  }

  /**
   * Host/co-host-initiated removal of an attendee — `DELETE
   * /events/:slug/attendees/:memberSlug`. Cancels whichever active RSVP the
   * target member holds (going, maybe, or waitlisted) and, exactly like a
   * member cancelling their own RSVP, pulls the waitlist head(s) up when a
   * 'going' seat was freed. Idempotent: removing someone with no active RSVP
   * (or already-cancelled) is a no-op.
   */
  async removeAttendee(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const targetUserId = await this.resolveMemberUserId(memberSlug);
    const result = await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      await this.assertOrganizer(manager, event, actorId);

      const rsvpRepo = manager.getRepository(EventRsvp);
      const target = await rsvpRepo.findOne({
        where: { eventId: event.id, userId: targetUserId },
      });
      if (!target || target.status === RsvpStatus.Cancelled) {
        return null;
      }
      const wasGoing = target.status === RsvpStatus.Going;
      target.status = RsvpStatus.Cancelled;
      target.waitlistPosition = null;
      await rsvpRepo.save(target);

      const promoted = wasGoing
        ? await this.promoteWaitlist(manager, event)
        : [];
      return { eventId: event.id, eventSlug: event.slug, promoted };
    });

    if (result) {
      this.emitPromotions(result.eventId, result.eventSlug, result.promoted);
    }
    return { ok: true };
  }

  /**
   * Host/co-host-initiated manual promotion — `POST
   * /events/:slug/waitlist/:memberSlug/promote`. Unlike the automatic FIFO
   * sweep in `promoteWaitlist` (which always admits the head of the queue),
   * this lets the host pick a specific waitlisted member out of order — the
   * same 'going' capacity check the automatic path enforces (via the same
   * `pessimistic_write` row lock), just for one targeted attendee instead of
   * a bulk sweep. The member's `waitlist_position` is simply cleared rather
   * than renumbering everyone behind them: the automatic sweep only ever
   * reads positions in ascending order, so a gap changes nothing about who's
   * "next".
   */
  async promoteAttendee(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<{ ok: true }> {
    const targetUserId = await this.resolveMemberUserId(memberSlug);
    const result = await this.dataSource.transaction(async (manager) => {
      const event = await manager.findOne(Event, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!event) {
        throw new NotFoundException('Event not found');
      }
      await this.assertOrganizer(manager, event, actorId);

      const rsvpRepo = manager.getRepository(EventRsvp);
      const target = await rsvpRepo.findOne({
        where: { eventId: event.id, userId: targetUserId },
      });
      if (!target || target.status !== RsvpStatus.Waitlisted) {
        throw new BadRequestException('That member is not on the waitlist');
      }
      if (event.capacity !== null) {
        const goingCount = await rsvpRepo.count({
          where: { eventId: event.id, status: RsvpStatus.Going },
        });
        if (goingCount >= event.capacity) {
          throw new BadRequestException('The event is at capacity');
        }
      }
      target.status = RsvpStatus.Going;
      target.waitlistPosition = null;
      await rsvpRepo.save(target);
      return { eventId: event.id, eventSlug: event.slug };
    });

    this.eventEmitter.emit(EVENT_WAITLIST_PROMOTED, {
      eventId: result.eventId,
      eventSlug: result.eventSlug,
      userId: targetUserId,
    } satisfies EventWaitlistPromotedEvent);
    return { ok: true };
  }

  /**
   * `PATCH /events/:slug/rsvp/details` — the caller's own RSVP only ("Anything
   * we should know?": guest count, access/dietary needs, visibility). Every
   * field is optional so a partial edit doesn't clobber the rest; only fields
   * actually present in `dto` are written.
   */
  async updateRsvpDetails(
    slug: string,
    userId: string,
    dto: UpdateRsvpDetailsDto,
  ): Promise<RsvpDetailsView> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    const rsvp = await this.rsvps.findOne({
      where: { eventId: event.id, userId },
    });
    if (!rsvp || rsvp.status === RsvpStatus.Cancelled) {
      throw new NotFoundException('You do not have an active RSVP to this event');
    }
    Object.assign(rsvp, {
      ...(dto.guestCount !== undefined ? { guestCount: dto.guestCount } : {}),
      ...(dto.accessNeeds !== undefined
        ? { accessNeeds: dto.accessNeeds }
        : {}),
      ...(dto.dietaryNeeds !== undefined
        ? { dietaryNeeds: dto.dietaryNeeds }
        : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
    });
    const saved = await this.rsvps.save(rsvp);
    return toRsvpDetailsView(saved);
  }

  // --- internals ---

  // Manager-scoped organizer check (host or co-host) — mirrors
  // `EventsService.isOrganizer`/`assertOrganizer` but reads through the
  // SAME transaction/lock as the event row this call is gating, matching
  // `assertMayRsvp`'s reasoning above.
  private async assertOrganizer(
    manager: EntityManager,
    event: Event,
    userId: string,
  ): Promise<void> {
    const isOrganizer =
      event.hostId === userId ||
      (await manager.exists(EventCohost, {
        where: { eventId: event.id, userId },
      }));
    if (!isOrganizer) {
      throw new ForbiddenException('Only the host or a co-host can do that');
    }
  }

  private async resolveMemberUserId(memberSlug: string): Promise<string> {
    const profile = await this.profiles.findOne({
      where: { slug: memberSlug },
    });
    if (!profile) {
      throw new NotFoundException('Member not found');
    }
    return profile.userId;
  }

  // Enforces the SAME gathering-audience-scope gate `EventsService
  // .assertCanView` applies to reads — see `EventAudienceGateService`'s class
  // doc. Fixed 2026-08-13 (fix round 1): before this, ONLY `invite_only` was
  // special-cased here and the event was loaded with no visibility check at
  // all, so a member with a guessable slug could RSVP into a
  // `network`/`extended_network`/`community` gathering they could not even
  // view. `isOrganizer` is computed the same way it always was for the prior
  // invite-only-only check (host, or a co-host row — via `manager`, so it
  // reads through the SAME transaction/lock as the event row this call is
  // gating) and handed to the shared gate, which then evaluates the tier
  // predicate itself (via its own injected `ConnectionsService`/
  // `CommunityMembershipService`/`EventInvite`/`EventRsvp` — deliberately NOT
  // `manager`-scoped, since these are read-only membership checks with no
  // write-race to guard against, unlike the capacity/waitlist logic this
  // transaction's `pessimistic_write` lock actually protects).
  private async assertMayRsvp(
    manager: EntityManager,
    event: Event,
    userId: string,
  ): Promise<void> {
    const isOrganizer =
      event.hostId === userId ||
      (await manager.exists(EventCohost, {
        where: { eventId: event.id, userId },
      }));
    await this.audienceGate.assertViewable(event, userId, isOrganizer);
  }

  // Promotes waitlist heads to 'going' while seats remain (or unconditionally
  // when capacity is unlimited). No-op unless the event is published. Returns the
  // ids of every promoted member so the caller can notify them.
  //
  // Bulk, not per-attendee: this runs under the caller's `pessimistic_write`
  // lock on the Event row, so every extra round trip here extends how long
  // that lock (and every other RSVP mutation on this event) is held. The old
  // shape did one count()+findOne()+save() per promoted attendee — for an
  // unlimited-capacity event with a long waitlist, that walked the whole
  // waitlist one row at a time inside the lock.
  private async promoteWaitlist(
    manager: EntityManager,
    event: Event,
  ): Promise<string[]> {
    if (event.status !== EventStatus.Published) {
      return [];
    }
    const rsvpRepo = manager.getRepository(EventRsvp);

    if (event.capacity === null) {
      // Unlimited capacity — every waitlisted attendee is promoted, so there's
      // no need to know the seat count or the promotion order up front: one
      // bulk UPDATE clears the whole waitlist in a single round trip.
      const promotionResult = await rsvpRepo
        .createQueryBuilder()
        .update(EventRsvp)
        .set({ status: RsvpStatus.Going, waitlistPosition: null })
        .where('event_id = :eventId', { eventId: event.id })
        .andWhere('status = :waitlisted', {
          waitlisted: RsvpStatus.Waitlisted,
        })
        .returning('*')
        .execute();
      return (promotionResult.raw as PromotedRsvpRow[]).map(
        (row) => row.user_id,
      );
    }

    // Finite capacity — only as many seats as are actually free. One SELECT
    // (ordered by waitlist_position, so the earliest waiters win the freed
    // seats) picks the exact rows to promote, then one bulk UPDATE by id
    // flips all of them at once.
    const goingCount = await rsvpRepo.count({
      where: { eventId: event.id, status: RsvpStatus.Going },
    });
    const freeSeats = event.capacity - goingCount;
    if (freeSeats <= 0) {
      return [];
    }
    const waitlistHeads = await rsvpRepo.find({
      where: { eventId: event.id, status: RsvpStatus.Waitlisted },
      order: { waitlistPosition: 'ASC' },
      take: freeSeats,
    });
    if (!waitlistHeads.length) {
      return [];
    }
    const waitlistHeadIds = waitlistHeads.map((rsvp) => rsvp.id);
    await rsvpRepo
      .createQueryBuilder()
      .update(EventRsvp)
      .set({ status: RsvpStatus.Going, waitlistPosition: null })
      .where('id IN (:...waitlistHeadIds)', { waitlistHeadIds })
      .execute();
    return waitlistHeads.map((rsvp) => rsvp.userId);
  }

  private async persistRsvp(
    rsvpRepo: Repository<EventRsvp>,
    existing: EventRsvp | null,
    eventId: string,
    userId: string,
    next: { status: RsvpStatus; waitlistPosition: number | null },
  ): Promise<void> {
    if (existing) {
      existing.status = next.status;
      existing.waitlistPosition = next.waitlistPosition;
      await rsvpRepo.save(existing);
    } else {
      await rsvpRepo.save(
        rsvpRepo.create({
          eventId,
          userId,
          status: next.status,
          waitlistPosition: next.waitlistPosition,
        }),
      );
    }
  }

  private emitPromotions(
    eventId: string,
    eventSlug: string,
    userIds: string[],
  ): void {
    for (const userId of userIds) {
      this.eventEmitter.emit(EVENT_WAITLIST_PROMOTED, {
        eventId,
        eventSlug,
        userId,
      } satisfies EventWaitlistPromotedEvent);
    }
  }
}
