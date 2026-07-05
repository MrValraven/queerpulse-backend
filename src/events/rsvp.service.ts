import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  EVENT_WAITLIST_PROMOTED,
  EventWaitlistPromotedEvent,
} from './event.events';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';

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
      };
    });

    this.emitPromotions(outcome.eventId, outcome.promoted);
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
      return { eventId: event.id, promoted };
    });

    if (result) {
      this.emitPromotions(result.eventId, result.promoted);
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
      return promoted.length ? { eventId: event.id, promoted } : null;
    });
    if (result) {
      this.emitPromotions(result.eventId, result.promoted);
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
  private async promoteWaitlist(
    manager: EntityManager,
    event: Event,
  ): Promise<string[]> {
    if (event.status !== EventStatus.Published) {
      return [];
    }
    const rsvpRepo = manager.getRepository(EventRsvp);
    const promoted: string[] = [];
    for (;;) {
      if (event.capacity !== null) {
        const goingCount = await rsvpRepo.count({
          where: { eventId: event.id, status: RsvpStatus.Going },
        });
        if (goingCount >= event.capacity) {
          break;
        }
      }
      const head = await rsvpRepo.findOne({
        where: { eventId: event.id, status: RsvpStatus.Waitlisted },
        order: { waitlistPosition: 'ASC' },
      });
      if (!head) {
        break;
      }
      head.status = RsvpStatus.Going;
      head.waitlistPosition = null;
      await rsvpRepo.save(head);
      promoted.push(head.userId);
    }
    return promoted;
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

  private emitPromotions(eventId: string, userIds: string[]): void {
    for (const userId of userIds) {
      this.eventEmitter.emit(EVENT_WAITLIST_PROMOTED, {
        eventId,
        userId,
      } satisfies EventWaitlistPromotedEvent);
    }
  }
}
