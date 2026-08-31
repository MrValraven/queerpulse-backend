import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, MoreThan, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import type { UpdateRsvpDetailsDto } from './dto/update-rsvp-details.dto';
import {
  EVENT_RSVPED,
  EVENT_WAITLIST_PROMOTED,
  EventRsvpedEvent,
  EventWaitlistPromotedEvent,
} from './event.events';
import { EventCapacityAlertsService } from './event-capacity-alerts.service';
import { RsvpDetailsView, toRsvpDetailsView } from './event-response';
import { EventAudienceGateService } from './event-audience-gate.service';
import { EventBan } from './entities/event-ban.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

// Raw row shape from the unlimited-capacity promotion UPDATE's RETURNING
// clause — column names are the actual (snake_case) DB columns, not the
// entity's camelCase.
interface PromotedRsvpRow {
  user_id: string;
}

/** One occurrence's cancel result, carried back out of the series transaction
 *  so the promotion notices can be emitted after it commits. */
interface CancelledRsvpOutcome {
  eventId: string;
  eventSlug: string;
  promoted: string[];
  seriesId: string | null;
  seriesIndex: number | null;
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
    // LOC-08. A block was honoured when RENDERING an attendee list and never
    // checked on the way IN, so someone a member had blocked could still walk
    // onto their gathering's roster and simply not appear in the list they
    // were standing next to. Checked in `assertMayRsvp` now, in both
    // directions.
    private readonly blockFilter: BlockFilterService,
    // "Last few spots" (PRD-18). Called post-commit whenever a seat is taken or
    // freed. Owns its own at-most-once claim and swallows its own failures, so
    // an alert can never fail somebody's RSVP.
    private readonly capacityAlerts: EventCapacityAlertsService,
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
      // A NULL `hostId` is a gathering whose host erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`): there is
      // nobody left to tell, so the notify path is skipped entirely.
      const notifyHost =
        event.hostId !== null &&
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
      //
      // SEATS, NOT ROWS (LOC-07). `guest_count` is the extra people an
      // attendee said they are bringing, and it never counted against
      // capacity: a 20-seat gathering where ten members each brought a
      // plus-one reported ten free seats while thirty people arrived. The
      // capacity check now measures the same number the response reports as
      // `seatsTaken`: one seat per going member, plus their declared guests.
      const seatsTaken = await this.goingSeatCount(rsvpRepo, event.id);
      // An existing 'going' row for this user shouldn't count against
      // capacity — neither their own seat nor the guests they already
      // declared, which are about to be re-counted below.
      const alreadyGoing = existing?.status === RsvpStatus.Going;
      const mySeats = 1 + (existing?.guestCount ?? 0);
      const effectiveSeats = alreadyGoing ? seatsTaken - mySeats : seatsTaken;

      let resolved: RsvpStatus;
      let waitlistPosition: number | null = null;

      if (
        event.capacity !== null &&
        effectiveSeats + mySeats > event.capacity
      ) {
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
    // A seat was taken (going) or handed back (maybe), so the gathering may
    // have just crossed into its last few spots, or back out of them. After
    // commit, and deliberately not awaited: the member's RSVP is done, and this
    // is a side effect that reads its own committed truth.
    void this.capacityAlerts.onSeatsChanged(outcome.eventId);
    // After commit (a mid-transaction emit would survive a rollback): tell the
    // host someone RSVPed. Fire-and-forget on the same bus as the waitlist
    // promotions above; the listener writes + pushes the notification.
    if (outcome.notifyHost && outcome.hostId !== null) {
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
    // ONE transaction for the whole series. Each occurrence used to get its
    // own, so a throw part-way through a `'future'` cancel left the member
    // still on the roster for the rest of the series (and any waitlist
    // promotions those cancels had already triggered stood), with an error and
    // no way to tell which occurrences went through. Siblings are locked in
    // `seriesIndex` order so two members leaving the same series concurrently
    // take the row locks in the same order rather than deadlocking.
    const outcomes = await this.dataSource.transaction(async (manager) => {
      const results: CancelledRsvpOutcome[] = [];
      const primary = await this.cancelRsvpOne(manager, slug, userId);
      results.push(primary);
      if (
        scope === 'future' &&
        primary.seriesId &&
        primary.seriesIndex !== null
      ) {
        const siblings = await manager.find(Event, {
          where: {
            seriesId: primary.seriesId,
            seriesIndex: MoreThan(primary.seriesIndex),
          },
          order: { seriesIndex: 'ASC' },
        });
        for (const sibling of siblings) {
          results.push(await this.cancelRsvpOne(manager, sibling.slug, userId));
        }
      }
      return results;
    });

    // Promotion notices ride out only once the cancels they follow from have
    // actually committed — a rolled-back transaction must not leave someone
    // told they got a seat.
    for (const outcome of outcomes) {
      this.emitPromotions(outcome.eventId, outcome.eventSlug, outcome.promoted);
      // Seats came back. Releasing the spent "last few spots" claim here is
      // what lets a gathering that empties and fills again earn a second alert.
      void this.capacityAlerts.onSeatsChanged(outcome.eventId);
    }
    return { ok: true };
  }

  // The actual single-event RSVP cancel — everything `cancelRsvp()` did
  // before MSG-10 added series scope, plus the event's own series linkage so
  // the public method above can find later siblings without a second lookup.
  // Runs on the CALLER'S transaction (see `cancelRsvp`) and emits nothing
  // itself, so the whole series commits or rolls back as one.
  private async cancelRsvpOne(
    manager: EntityManager,
    slug: string,
    userId: string,
  ): Promise<CancelledRsvpOutcome> {
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
        promoted: [],
        seriesId: event.seriesId,
        seriesIndex: event.seriesIndex,
      };
    }
    const wasGoing = mine.status === RsvpStatus.Going;
    mine.status = RsvpStatus.Cancelled;
    mine.waitlistPosition = null;
    // The MEMBER ended this one. Explicitly cleared, not merely left alone:
    // changing your mind must never leave you looking removed, or a member
    // who cancels once could never come back (LOC-08).
    mine.removedByHostAt = null;
    mine.checkedInAt = null;
    await rsvpRepo.save(mine);

    // A freed 'going' seat pulls the head(s) of the waitlist up.
    const promoted = wasGoing ? await this.promoteWaitlist(manager, event) : [];
    return {
      eventId: event.id,
      eventSlug: event.slug,
      promoted,
      seriesId: event.seriesId,
      seriesIndex: event.seriesIndex,
    };
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
      // THE HOST ended this one (LOC-08). Without this stamp the row was
      // indistinguishable from a self-cancellation, so the removed member
      // could press "going" again a second later and removal was worth
      // nothing. `assertMayRsvp` reads it.
      target.removedByHostAt = new Date();
      target.checkedInAt = null;
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
        // Seats, not rows (LOC-07) — and the promoted member's own party has
        // to fit, not just their single row.
        const seatsTaken = await this.goingSeatCount(rsvpRepo, event.id);
        const seatsNeeded = 1 + target.guestCount;
        if (seatsTaken + seatsNeeded > event.capacity) {
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
      throw new NotFoundException(
        'You do not have an active RSVP to this event',
      );
    }
    // Raising the guest count is a capacity change (LOC-07): every extra
    // guest occupies a seat, so an unchecked edit here would walk straight
    // past the check `rsvp()` now performs. Only a RAISE is checked, and only
    // for a 'going' row: lowering always fits, and a waitlisted member is not
    // taking a seat yet.
    if (
      dto.guestCount !== undefined &&
      dto.guestCount > rsvp.guestCount &&
      rsvp.status === RsvpStatus.Going &&
      event.capacity !== null
    ) {
      const seatsTaken = await this.goingSeatCount(this.rsvps, event.id);
      const extraSeats = dto.guestCount - rsvp.guestCount;
      if (seatsTaken + extraSeats > event.capacity) {
        throw new BadRequestException(
          'There is not enough room left for that many guests',
        );
      }
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

    // ── LOC-08: the host's own door ──────────────────────────────────────
    // An organiser can always reach their own gathering, so neither check
    // below can lock a host out of an event they are running.
    if (isOrganizer) return;

    // A ban is one host saying "not at my table", scoped to this gathering.
    // Answered with an explicit, renderable message rather than a 404: the
    // member already knows the gathering exists (they were on the page), and
    // pretending otherwise would just make them press the button again.
    const isBanned = await manager.exists(EventBan, {
      where: { eventId: event.id, userId },
    });
    if (isBanned) {
      throw new ForbiddenException(
        'The host has removed you from this gathering',
      );
    }

    // A block, in EITHER direction, between this member and the host. The
    // attendee list has always dropped blocked members from what a viewer
    // sees; until now nothing stopped them joining it. A blocked member
    // showing up in person is the failure that matters.
    if (event.hostId !== null) {
      const isBlocked = await this.blockFilter.isBlockedEitherWay(
        userId,
        event.hostId,
      );
      if (isBlocked) {
        throw new ForbiddenException(
          'You cannot RSVP to a gathering hosted by someone you have blocked, or who has blocked you',
        );
      }
    }

    // Removed by the host earlier (LOC-08 hole 1). A cancelled row used to
    // read as "never RSVPed", so pressing the button again put the member
    // straight back on the roster and removal was worth nothing. A member who
    // cancelled THEMSELVES is untouched by this: `cancelRsvpOne` clears the
    // stamp, so changing your mind twice is still allowed.
    const removed = await manager.getRepository(EventRsvp).findOne({
      where: { eventId: event.id, userId },
    });
    if (
      removed &&
      removed.status === RsvpStatus.Cancelled &&
      removed.removedByHostAt !== null
    ) {
      throw new ForbiddenException(
        'The host has removed you from this gathering',
      );
    }
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
    //
    // SEATS, NOT ROWS (LOC-07): both sides of this subtraction now count
    // declared guests. Two free seats admit one waiting member bringing a
    // friend, or two waiting alone, and never two members bringing four
    // people between them.
    const seatsTaken = await this.goingSeatCount(rsvpRepo, event.id);
    const freeSeats = event.capacity - seatsTaken;
    if (freeSeats <= 0) {
      return [];
    }
    const waitingInOrder = await rsvpRepo.find({
      where: { eventId: event.id, status: RsvpStatus.Waitlisted },
      order: { waitlistPosition: 'ASC' },
    });
    // Strictly in queue order, and a party that does not fit does NOT let a
    // smaller party behind it jump the line: the member at the head of the
    // waitlist keeps their place until the room genuinely has room for them.
    const waitlistHeads: EventRsvp[] = [];
    let remainingSeats = freeSeats;
    for (const waiting of waitingInOrder) {
      const seatsNeeded = 1 + waiting.guestCount;
      if (seatsNeeded > remainingSeats) break;
      waitlistHeads.push(waiting);
      remainingSeats -= seatsNeeded;
    }
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

  /**
   * How many SEATS this event's 'going' RSVPs occupy: one per member, plus
   * every extra guest they declared (`event_rsvps.guest_count`).
   *
   * The single definition of "how full is it" on the write side, matching
   * `EventsService.rosterCounts` on the read side. Before LOC-07 both were a
   * plain row count, so a gathering could be sold as having ten free seats to
   * thirty people.
   */
  private async goingSeatCount(
    rsvpRepo: Repository<EventRsvp>,
    eventId: string,
  ): Promise<number> {
    const row = await rsvpRepo
      .createQueryBuilder('r')
      .select('COUNT(*) + COALESCE(SUM(r.guest_count), 0)', 'seats')
      .where('r.event_id = :eventId', { eventId })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .getRawOne<{ seats: string | null }>();
    return Number(row?.seats ?? 0);
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
      // Reaching here means `assertMayRsvp` let them through, so any earlier
      // host removal has been lifted (or was never there). Clearing it keeps
      // "was this row ended by the host" answerable about the CURRENT row
      // rather than about its history (LOC-08).
      existing.removedByHostAt = null;
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
