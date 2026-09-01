import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import { EventSeries } from '../events/entities/event-series.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  OpportunityStatus,
  VolunteerOpportunity,
} from '../volunteering/entities/volunteer-opportunity.entity';

/**
 * Handles what happens to the things OTHER PEOPLE were counting on when the
 * member who created them erases their account.
 *
 * ## Why this exists
 *
 * `events.host_id`, `listings.owner_id`, `jobs.poster_id` and their siblings
 * used to be `ON DELETE CASCADE` to `users`. One person
 * exercising erasure silently deleted every gathering they hosted, including
 * future ones, with everybody's RSVPs, and every listing and review they ever
 * wrote. `SetNullContentAuthorFksOnUserErasure1794610000000` changes those FKs
 * to `SET NULL`, which stops the deletion. This service is the other half:
 * "the row survives with a NULL host" is the right database answer and a bad
 * product answer for a gathering that is still on the calendar with forty
 * people going and nobody to open the door.
 *
 * So, for the erased member's FUTURE gatherings:
 *  - hand it to a co-host if the event has one (they were already an
 *    organizer, so nothing new is granted);
 *  - otherwise cancel it and tell everyone with a live RSVP, through the same
 *    `EventCancelled` notification the host's own cancel button fires.
 *
 * And for the things people can still apply or reply to, which would otherwise
 * sit live with nobody reading them: open jobs and volunteering are closed,
 * and live housing listings are taken off the market with the same `filledAt`
 * stamp the owner's own "mark filled" and the expiry sweeper use.
 *
 * Deliberately NOT handled here:
 *  - business directory listings (`listings.owner_id`) stay live and simply
 *    become unclaimed. A venue's directory entry is a record about a real
 *    place that has nothing to do with the member leaving, and the existing
 *    `listing_claims` flow is exactly how an unowned entry finds a new owner.
 *    Ownership is deliberately NOT handed to a co-manager: that table's own
 *    design note states a co-manager is never written into `owner_id`.
 *  - companies (`companies.owner_id`) likewise become unclaimed; a team-member
 *    row is not a claim to ownership.
 *  - reviews and nominations (`company_reviews`, `housing_reviews`,
 *    `safe_space_nominations`) keep their text and lose their byline, which is
 *    the whole point of the `SET NULL` conversion: the next applicant, tenant
 *    or moderator still needs to read them.
 *  - gathering photos (`event_photos.uploader_id`, `SET NULL` since
 *    `AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`) stay in the
 *    album they were added to and lose their uploader, on the same reasoning
 *    as the reviews above: an album is the shared record of an event that
 *    other attendees are in, and one attendee leaving does not withdraw the
 *    photographs they took of everyone else. Nothing to do here, but the
 *    STORAGE side of that promise had to be repaired:
 *    `AccountDeletionProcessorService` step 4 used to delete every object under
 *    the member's key prefixes, which left these rows pointing at deleted
 *    objects. It now deletes only objects no surviving row references.
 *
 * ## Wiring: READ BEFORE CALLING
 *
 * `eraseFor` MUST be called BEFORE `AccountDeletionProcessorService
 * .eraseAccount`'s `manager.delete(User, { id: userId })`. It finds its work
 * by `host_id = :userId` / `poster_id = :userId` / `owner_id = :userId`, and
 * once the user row is gone the `SET NULL` FKs have already blanked every one
 * of those columns, leaving no trace of who hosted what.
 *
 * Every step is idempotent: each only ever matches rows still attributed to
 * `userId` AND still in the state that needs changing (future and not
 * cancelled, open, not yet filled), so a retry after a partial run finds
 * nothing left to do. That is what makes it safe to run outside the erasure
 * transaction, the same trade-off `CommunityOwnerOrphanService` already
 * documents at the same call site.
 */
@Injectable()
export class ContentOwnerErasureService {
  private readonly logger = new Logger(ContentOwnerErasureService.name);

  constructor(
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventSeries)
    private readonly eventSeries: Repository<EventSeries>,
    @InjectRepository(Job)
    private readonly jobs: Repository<Job>,
    @InjectRepository(VolunteerOpportunity)
    private readonly opportunities: Repository<VolunteerOpportunity>,
    @InjectRepository(HousingListing)
    private readonly housingListings: Repository<HousingListing>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Resolve everything the erased member is on the hook for, before their
   * user row goes.
   *
   * Each step is isolated: one failing must not strand the rest (mirrors
   * `AccountDeletionProcessorService.eraseDueAccounts`'s per-row isolation and
   * `CommunityOwnerOrphanService.handleOwnerErasure`'s per-community one).
   * A failure here is logged rather than thrown, because the erasure itself is
   * the legally-binding step and must not be blocked by a gathering handover.
   */
  async eraseFor(userId: string): Promise<void> {
    await this.runIsolated('future gatherings', () =>
      this.handleFutureGatherings(userId),
    );
    await this.runIsolated('open job postings', () =>
      this.closeOpenJobs(userId),
    );
    await this.runIsolated('open volunteering opportunities', () =>
      this.closeOpenOpportunities(userId),
    );
    await this.runIsolated('live housing listings', () =>
      this.withdrawHousingListings(userId),
    );
  }

  private async runIsolated(
    step: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Account erasure could not resolve ${step}: ` +
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  // --- gatherings ------------------------------------------------------------

  /**
   * Every not-yet-cancelled gathering the erased member hosts that has not
   * started yet. A gathering already in the past keeps its erased host as a
   * NULL byline: it happened, and cancelling history would be a lie.
   *
   * Drafts are in scope alongside published gatherings. A draft with no host
   * left can never be published by anyone, and it carries no RSVPs, so
   * cancelling it closes it out without notifying a soul.
   */
  private async handleFutureGatherings(userId: string): Promise<void> {
    const futureEvents = await this.events.find({
      where: {
        hostId: userId,
        status: Not(EventStatus.Cancelled),
        startAt: MoreThan(new Date()),
      },
      order: { startAt: 'ASC' },
    });
    // No future occurrence means no co-host can inherit anything, so the
    // series pass below has nothing to hand over either.
    if (!futureEvents.length) return;

    // ONE batched co-host lookup for the whole set, never one query per event.
    const cohostRows = await this.cohosts.find({
      where: { eventId: In(futureEvents.map((event) => event.id)) },
      order: { createdAt: 'ASC' },
    });
    const successorByEventId = new Map<string, string>();
    for (const cohost of cohostRows) {
      // Longest-standing co-host wins, and the erased member's own co-host row
      // (a host who also sits on the roster) is never a successor to itself.
      if (cohost.userId === userId) continue;
      if (!successorByEventId.has(cohost.eventId)) {
        successorByEventId.set(cohost.eventId, cohost.userId);
      }
    }

    const handedOver: Event[] = [];
    const cancelled: Event[] = [];
    for (const event of futureEvents) {
      const successorUserId = successorByEventId.get(event.id);
      if (successorUserId === undefined) {
        cancelled.push(event);
      } else {
        handedOver.push(event);
      }
    }

    await this.handOverEvents(handedOver, successorByEventId);
    await this.cancelEvents(cancelled);
    await this.releaseHostedSeries(userId, successorByEventId);
  }

  /**
   * Promote the chosen co-host to host. Their `event_cohosts` row is removed
   * in the same pass so the same member is not both host and co-host, which
   * would render them twice on the gathering's organizer list.
   */
  private async handOverEvents(
    events: Event[],
    successorByEventId: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const event of events) {
      const successorUserId = successorByEventId.get(event.id);
      if (successorUserId === undefined) continue;
      await this.events.update({ id: event.id }, { hostId: successorUserId });
      await this.cohosts.delete({
        eventId: event.id,
        userId: successorUserId,
      });
      this.logger.log(
        `Gathering ${event.id} handed to co-host ${successorUserId} ` +
          `after the host's account was erased`,
      );
    }
  }

  /**
   * No co-host to hand it to, so the gathering is called off rather than left
   * on the calendar with nobody to run it. Status flips first, in ONE
   * statement for the whole set, then the fan-out runs against committed
   * state, the ordering `EventsService.cancel` already establishes, so a
   * failure part-way through never tells attendees a gathering is off while
   * the row still reads published.
   */
  private async cancelEvents(events: Event[]): Promise<void> {
    if (!events.length) return;
    await this.events.update(
      { id: In(events.map((event) => event.id)) },
      { status: EventStatus.Cancelled },
    );
    for (const event of events) {
      await this.notifyAttendeesCancelled(event);
    }
  }

  /**
   * Same recipients and same payload as `EventsService.notifyEventCancelled`:
   * anyone with a live RSVP (going/maybe/waitlisted). Deliberately reuses the
   * existing `EventCancelled` type, so the bell, the push channel and the
   * MyEvents "what changed" panel all render it with no new plumbing.
   *
   * Best-effort per gathering: the cancellation itself has already committed,
   * and a notification failure must not stop the remaining gatherings from
   * being handled.
   */
  private async notifyAttendeesCancelled(event: Event): Promise<void> {
    try {
      const rsvps = await this.rsvps.find({
        where: {
          eventId: event.id,
          status: In([
            RsvpStatus.Going,
            RsvpStatus.Maybe,
            RsvpStatus.Waitlisted,
          ]),
        },
      });
      const recipientIds = rsvps.map((rsvp) => rsvp.userId);
      if (!recipientIds.length) return;
      // No `actorId`: there is no acting member to name. The gathering was
      // cancelled by the platform because its host is gone.
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.EventCancelled,
        {
          eventId: event.id,
          eventSlug: event.slug,
          title: event.title,
          startAt: event.startAt.toISOString(),
        },
      );
    } catch (error) {
      this.logger.error(
        `Gathering ${event.id} was cancelled for an erased host, but telling ` +
          `its attendees failed: ` +
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /**
   * A recurring gathering's repeat rule follows its occurrences: if any future
   * occurrence went to a co-host, that member takes the series too, so they
   * can edit the schedule they are now running. A series whose occurrences
   * were all cancelled keeps no host, and the FK blanks `host_id` when the
   * user row goes.
   */
  private async releaseHostedSeries(
    userId: string,
    successorByEventId: ReadonlyMap<string, string>,
  ): Promise<void> {
    const hostedSeries = await this.eventSeries.find({
      where: { hostId: userId },
    });
    if (!hostedSeries.length) return;

    // The successor for a series is the one chosen for its EARLIEST future
    // occurrence, so a series with different co-hosts per occurrence resolves
    // deterministically rather than by row order.
    const occurrences = await this.events.find({
      where: {
        seriesId: In(hostedSeries.map((series) => series.id)),
        startAt: MoreThan(new Date()),
      },
      order: { startAt: 'ASC' },
    });
    const successorBySeriesId = new Map<string, string>();
    for (const occurrence of occurrences) {
      if (occurrence.seriesId === null) continue;
      if (successorBySeriesId.has(occurrence.seriesId)) continue;
      const successorUserId = successorByEventId.get(occurrence.id);
      if (successorUserId === undefined) continue;
      successorBySeriesId.set(occurrence.seriesId, successorUserId);
    }

    for (const [seriesId, successorUserId] of successorBySeriesId) {
      await this.eventSeries.update(
        { id: seriesId },
        { hostId: successorUserId },
      );
    }
  }

  // --- things people can still apply or reply to ------------------------------

  /**
   * An open role whose poster is gone takes applications nobody will ever
   * read. Closing it keeps the posting and its application history readable
   * while stopping the queue from growing.
   */
  private async closeOpenJobs(userId: string): Promise<void> {
    const closed = await this.jobs.update(
      { posterId: userId, status: JobStatus.Open },
      { status: JobStatus.Closed },
    );
    if (closed.affected) {
      this.logger.log(
        `Closed ${closed.affected} open job posting(s) for erased account ${userId}`,
      );
    }
  }

  /** Same reasoning as `closeOpenJobs`, for volunteering signups. */
  private async closeOpenOpportunities(userId: string): Promise<void> {
    const closed = await this.opportunities.update(
      { posterId: userId, status: OpportunityStatus.Open },
      { status: OpportunityStatus.Closed },
    );
    if (closed.affected) {
      this.logger.log(
        `Closed ${closed.affected} open volunteering opportunity(ies) for ` +
          `erased account ${userId}`,
      );
    }
  }

  /**
   * Takes the erased member's homes off the market with the same `filledAt`
   * stamp the owner's own "mark filled" control and
   * `HousingListingExpirySweeperService` already use, so every read path that
   * hides a filled listing hides these too with no new state to teach them.
   * The row itself stays, because its viewings and reviews are other members'
   * records of a real interaction.
   *
   * Already-filled and already-expired listings are left alone: `filledAt IS
   * NULL` is what makes this idempotent, and re-stamping an expiry the sweeper
   * set would rewrite somebody else's timestamp.
   */
  private async withdrawHousingListings(userId: string): Promise<void> {
    const withdrawn = await this.housingListings.update(
      {
        ownerId: userId,
        filledAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      { filledAt: new Date() },
    );
    if (withdrawn.affected) {
      this.logger.log(
        `Took ${withdrawn.affected} live housing listing(s) off the market ` +
          `for erased account ${userId}`,
      );
    }
  }
}
