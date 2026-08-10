import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  EVENT_RSVPED,
  EVENT_WAITLIST_PROMOTED,
  EventRsvpedEvent,
  EventWaitlistPromotedEvent,
} from './event.events';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';

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

  async cancelRsvp(slug: string, userId: string): Promise<{ ok: true }> {
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
        return null;
      }
      const wasGoing = mine.status === RsvpStatus.Going;
      mine.status = RsvpStatus.Cancelled;
      mine.waitlistPosition = null;
      await rsvpRepo.save(mine);

      // A freed 'going' seat pulls the head(s) of the waitlist up.
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

  // --- internals ---

  // Invite-only events accept RSVPs only from organizers and invited members.
  private async assertMayRsvp(
    manager: EntityManager,
    event: Event,
    userId: string,
  ): Promise<void> {
    if (event.visibility !== EventVisibility.InviteOnly) {
      return;
    }
    if (event.hostId === userId) {
      return;
    }
    const isCohost = await manager.exists(EventCohost, {
      where: { eventId: event.id, userId },
    });
    if (isCohost) {
      return;
    }
    const invited = await manager.exists(EventInvite, {
      where: { eventId: event.id, inviteeId: userId },
    });
    if (!invited) {
      throw new ForbiddenException('This event is invite-only');
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
