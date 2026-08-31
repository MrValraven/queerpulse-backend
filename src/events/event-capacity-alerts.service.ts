import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventBookmark } from './entities/event-bookmark.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

/**
 * How few seats count as "the last few spots".
 *
 * A round number a member can hold in their head, and the same one the copy
 * says out loud. It is a floor on the count rather than a percentage: three
 * seats left is three seats left whether the room holds twenty or two hundred,
 * and a percentage would fire a 200-seat gathering's alert with twenty seats
 * still going, which nobody would call the last few spots.
 */
export const NEARLY_FULL_REMAINING_SEATS = 3;

/**
 * The smallest capacity worth alerting on.
 *
 * A gathering for four is nearly full from its first RSVP, so an alert there
 * says nothing the member could not already see. Twice the threshold is the
 * point where "the last few spots" is news rather than arithmetic.
 */
export const NEARLY_FULL_MIN_CAPACITY = NEARLY_FULL_REMAINING_SEATS * 2;

/**
 * "Last few spots" (PRD-18): tells the members weighing up a gathering that the
 * room is about to close.
 *
 * Capacity, the waitlist and saved gatherings all already existed, and none of
 * them ever reached the one person the information was for. The settings pane
 * even carried a "Last few spots" switch, wired to nothing.
 *
 * WHO HEARS IT. Members who saved the gathering, and members who RSVP'd
 * `maybe`. Both are holding an unmade decision this changes. Anyone already
 * `going` has a seat and would only be told their own gathering is popular;
 * anyone `waitlisted` found out it was full when they were put on the waitlist.
 *
 * ONCE PER GATHERING, claimed on `events.nearly_full_notified_at` with a
 * conditional UPDATE, so two RSVPs landing together cannot both send. The claim
 * is cleared again when seats free up past the threshold, so a gathering that
 * fills, empties and fills again earns a second alert.
 *
 * BEST EFFORT, ALWAYS. Every entry point swallows its own failures: a member's
 * RSVP must never fail because an alert could not be sent.
 */
@Injectable()
export class EventCapacityAlertsService {
  private readonly logger = new Logger(EventCapacityAlertsService.name);

  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventBookmark)
    private readonly bookmarks: Repository<EventBookmark>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Called after a seat is taken or freed, post-commit. Sends the alert when
   * the gathering has just crossed into its last few spots, and releases a
   * spent claim when it has come back out of them.
   *
   * Fire-and-forget by contract: the caller does not await a result it could
   * act on, and nothing in here is allowed to reach the RSVP that triggered it.
   */
  async onSeatsChanged(eventId: string): Promise<void> {
    try {
      await this.reconcile(eventId);
    } catch (error) {
      this.logger.warn(
        `Capacity alert check failed for event ${eventId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async reconcile(eventId: string): Promise<void> {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event || event.capacity === null) {
      return;
    }
    // A draft or cancelled gathering has nobody to tell, and one that has
    // already started cannot be joined on the strength of this alert.
    if (event.status !== EventStatus.Published) {
      return;
    }
    if (event.startAt.getTime() <= Date.now()) {
      return;
    }
    if (event.capacity < NEARLY_FULL_MIN_CAPACITY) {
      return;
    }

    const seatsRemaining =
      event.capacity - (await this.goingSeatCount(eventId));
    if (seatsRemaining > NEARLY_FULL_REMAINING_SEATS) {
      // Back out of the danger zone: release the claim so a later fill earns
      // its own alert instead of the first one silencing every future one.
      if (event.nearlyFullNotifiedAt !== null) {
        await this.events.update(
          { id: event.id },
          { nearlyFullNotifiedAt: null },
        );
      }
      return;
    }
    // Full is not "nearly full": once the last seat goes the honest state is a
    // waitlist, and `waitlist_promoted` is the notification that says so.
    if (seatsRemaining <= 0) {
      return;
    }

    // Claim BEFORE sending, conditionally, so a concurrent RSVP that also
    // crossed the line loses the race and sends nothing.
    const claim = await this.events.update(
      { id: event.id, nearlyFullNotifiedAt: IsNull() },
      { nearlyFullNotifiedAt: new Date() },
    );
    if (claim.affected !== 1) {
      return;
    }

    try {
      await this.notifications.createForRecipients(
        await this.interestedUserIds(event.id),
        NotificationType.EventNearlyFull,
        {
          source: 'event',
          eventSlug: event.slug,
          title: event.title,
          seatsRemaining,
        },
      );
    } catch (error) {
      // Hand the claim back so the next RSVP retries, exactly as the reminder
      // sweep releases its own claim on a failed send. A permanently stamped
      // event would mean nobody is ever told.
      await this.events.update(
        { id: event.id },
        { nearlyFullNotifiedAt: null },
      );
      throw error;
    }
  }

  /**
   * The members holding an unmade decision about this gathering: everyone who
   * saved it, plus everyone who said `maybe`, minus anyone whose RSVP already
   * settled the question (`going` has a seat, `waitlisted` already knows).
   */
  private async interestedUserIds(eventId: string): Promise<string[]> {
    const [saved, maybes, settled] = await Promise.all([
      this.bookmarks.find({
        where: { eventId },
        select: { userId: true },
      }),
      this.rsvps.find({
        where: { eventId, status: RsvpStatus.Maybe },
        select: { userId: true },
      }),
      this.rsvps.find({
        where: {
          eventId,
          status: In([RsvpStatus.Going, RsvpStatus.Waitlisted]),
        },
        select: { userId: true },
      }),
    ]);
    const settledUserIds = new Set(settled.map((rsvp) => rsvp.userId));
    const interested = new Set<string>();
    for (const row of [...saved, ...maybes]) {
      if (!settledUserIds.has(row.userId)) {
        interested.add(row.userId);
      }
    }
    return [...interested];
  }

  /**
   * Seats taken, counted the way `RsvpService` counts them (LOC-07): one per
   * going member plus the guests they declared. Restated here rather than
   * reached for across services, because injecting `RsvpService` would close a
   * cycle back into the service that calls this one.
   */
  private async goingSeatCount(eventId: string): Promise<number> {
    const row = await this.rsvps
      .createQueryBuilder('r')
      .select('COUNT(*) + COALESCE(SUM(r.guest_count), 0)', 'seats')
      .where('r.event_id = :eventId', { eventId })
      .andWhere('r.status = :status', { status: RsvpStatus.Going })
      .getRawOne<{ seats: string | null }>();
    return Number(row?.seats ?? 0);
  }
}
