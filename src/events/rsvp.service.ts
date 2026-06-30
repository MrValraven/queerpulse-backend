import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  EVENT_WAITLIST_PROMOTED,
  EventWaitlistPromotedEvent,
} from './event.events';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

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
    return this.dataSource.transaction(async (manager) => {
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

      const rsvpRepo = manager.getRepository(EventRsvp);
      let resolved: RsvpStatus;
      let waitlistPosition: number | null = null;

      if (status === 'maybe') {
        resolved = RsvpStatus.Maybe;
      } else {
        // 'going' — apply capacity → waitlist.
        const goingCount = await rsvpRepo.count({
          where: { eventId: event.id, status: RsvpStatus.Going },
        });
        // An existing 'going' row for this user shouldn't count against capacity.
        const existing = await rsvpRepo.findOne({
          where: { eventId: event.id, userId },
        });
        const alreadyGoing = existing?.status === RsvpStatus.Going;
        const effectiveGoing = alreadyGoing ? goingCount - 1 : goingCount;
        if (event.capacity !== null && effectiveGoing >= event.capacity) {
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
      }

      const existing = await rsvpRepo.findOne({
        where: { eventId: event.id, userId },
      });
      if (existing) {
        existing.status = resolved;
        existing.waitlistPosition = waitlistPosition;
        await rsvpRepo.save(existing);
      } else {
        await rsvpRepo.save(
          rsvpRepo.create({
            eventId: event.id,
            userId,
            status: resolved,
            waitlistPosition,
          }),
        );
      }
      return { status: resolved, waitlistPosition };
    });
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

      // Promote the head of the waitlist when a capacity-bound 'going' frees up.
      if (wasGoing && event.capacity !== null) {
        const head = await rsvpRepo.findOne({
          where: { eventId: event.id, status: RsvpStatus.Waitlisted },
          order: { waitlistPosition: 'ASC' },
        });
        if (head) {
          head.status = RsvpStatus.Going;
          head.waitlistPosition = null;
          await rsvpRepo.save(head);
          return { eventId: event.id, promotedUserId: head.userId };
        }
      }
      return null;
    });

    if (result) {
      this.eventEmitter.emit(EVENT_WAITLIST_PROMOTED, {
        eventId: result.eventId,
        userId: result.promotedUserId,
      } satisfies EventWaitlistPromotedEvent);
    }
    return { ok: true };
  }
}
