import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { EventCohost } from '../events/entities/event-cohost.entity';
import {
  EventInvite,
  EventInviteStatus,
} from '../events/entities/event-invite.entity';
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
 * So, for the erased member's gatherings that are not yet OVER, which includes
 * a multi-day one that is running right now:
 *  - hand it to a co-host if the event has one (they were already an
 *    organizer, so nothing new is granted);
 *  - otherwise, if it has not started yet, cancel it and tell everyone with a
 *    live RSVP or a pending invite, through the same `EventCancelled`
 *    notification the host's own cancel button fires;
 *  - a gathering already UNDER WAY with no co-host is left to finish. See
 *    `handleFutureGatherings` for why cancelling a room full of people who
 *    already turned up would be worse than the silence it replaces.
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
 * `userId` AND still in the state that needs changing (unfinished and not
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
    @InjectRepository(EventInvite)
    private readonly invites: Repository<EventInvite>,
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
    await this.runIsolated('unfinished gatherings', () =>
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
   * Every not-yet-cancelled gathering the erased member hosts that is not yet
   * OVER, which includes one that is running right now. A gathering already in
   * the past keeps its erased host as a NULL byline: it happened, and
   * cancelling history would be a lie.
   *
   * "Not over" is an interval question, so the selection is the same two-arm
   * OR that `EventsService.list`'s 'upcoming' branch and
   * `community-public.service.ts` already use, and it agrees exactly with
   * `hasEnded` in `events/event-timing.ts` (`endAt ?? startAt`). Find-options
   * cannot write the disjunct inline, so the two arms each carry the whole
   * scope; `endAt: MoreThan(now)` carries the `end_at IS NOT NULL` half for
   * free, since SQL never matches NULL against `>`. Asked point-in-time
   * against `start_at`, a three-day festival whose host erased their account
   * on day two fell out of this method entirely, which is precisely the
   * "forty people going and nobody to open the door" case the class docblock
   * above says this service exists for.
   *
   * THE TWO OUTCOMES ARE SCOPED DIFFERENTLY, deliberately:
   *
   *  - HANDOVER covers a gathering that is running as well as one still to
   *    come. The successor is already a co-host, so nothing new is granted,
   *    and they are very likely the person actually running the room right
   *    now. Without this they inherit nothing and the live gathering has no
   *    organizer who can edit it, message its attendees or check anyone in.
   *  - CANCELLATION stays restricted to gatherings that have NOT STARTED.
   *    Flipping a gathering to `cancelled` fires `EventCancelled` at everyone
   *    holding an RSVP or an invite, and telling a room full of people who are
   *    physically present that the thing they are at is off would be worse
   *    than the silence it replaces. A running gathering with no co-host is
   *    therefore left alone to finish; within `MAX_GATHERING_SPAN_DAYS` it
   *    becomes history with a NULL byline, which is what the past-gathering
   *    rule above already prescribes. It is logged so the case is visible
   *    rather than silent.
   *
   * Drafts are in scope alongside published gatherings. A draft that has not
   * started can never be published by anyone once its host is gone, and it
   * carries no RSVPs, so cancelling it closes it out without notifying a soul.
   *
   * OPEN CASE, left as it is on purpose so somebody can decide it later: a
   * draft whose start has already passed while it is still within its stated
   * end takes the under-way branch above, which exists to protect attendees.
   * A draft has none. So such a draft is skipped and left published-never,
   * permanently unpublishable with a host the FK is about to null, where the
   * old point-in-time filter would have cancelled it outright (drafts used to
   * be either future, and cancelled, or past, and left as history). The window
   * is narrow (a draft with a stated end, abandoned mid-span, whose host
   * erases in exactly that window) and nothing is exposed to anyone by it,
   * which is why this is a note rather than a branch. Cancelling an under-way
   * DRAFT specifically would be safe, since the notification fan-out reaches
   * only RSVPs and invites, and a draft has neither.
   */
  private async handleFutureGatherings(userId: string): Promise<void> {
    // One instant for the whole pass, so the query below and the
    // has-it-started split further down cannot disagree about "now".
    const now = new Date();
    const unfinishedScope = {
      hostId: userId,
      status: Not(EventStatus.Cancelled),
    };
    const unfinishedEvents = await this.events.find({
      where: [
        { ...unfinishedScope, startAt: MoreThan(now) },
        { ...unfinishedScope, endAt: MoreThan(now) },
      ],
      order: { startAt: 'ASC' },
    });
    // Nothing unfinished means no co-host can inherit anything, so the series
    // pass below has nothing to hand over either.
    if (!unfinishedEvents.length) return;

    // ONE batched co-host lookup for the whole set, never one query per event.
    const cohostRows = await this.cohosts.find({
      where: { eventId: In(unfinishedEvents.map((event) => event.id)) },
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
    for (const event of unfinishedEvents) {
      const successorUserId = successorByEventId.get(event.id);
      if (successorUserId !== undefined) {
        handedOver.push(event);
        continue;
      }
      // See the docblock: a gathering already under way is never cancelled out
      // from under the people standing in it.
      if (event.startAt.getTime() <= now.getTime()) {
        this.logger.log(
          `Gathering ${event.id} is under way with no co-host to inherit it ` +
            `after the host's account was erased; leaving it to finish rather ` +
            `than cancelling it on its attendees`,
        );
        continue;
      }
      cancelled.push(event);
    }

    await this.handOverEvents(handedOver, successorByEventId);
    await this.cancelEvents(cancelled);
    await this.releaseHostedSeries(userId, successorByEventId, now);
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
    await this.notifyAttendeesCancelled(events);
  }

  /**
   * Tell everyone with a stake in these cancellations that they are off.
   *
   * Kept in lockstep with `EventsService.notifyEventCancelled`, which this
   * mirrors. Two things it did not used to do, both fixed here so an erased
   * host's attendees are not told less than a departing host's:
   *
   *  - **Invitees are recipients too** (PRD-185). It read RSVP rows only, so
   *    somebody holding a standing invitation was never told, the invite
   *    stayed in their list, and accepting it handed them a 400 they could not
   *    read.
   *  - **One message for the whole erasure, not one per gathering** (ENG-141).
   *    It looped, writing a row and firing a push per gathering per recipient,
   *    so a regular of an erased host's weekly group got one push per
   *    remaining week in a burst. The recipients are now the union across all
   *    of them, de-duplicated.
   *
   * The payload describes the SOONEST cancelled gathering and carries
   * `occurrenceCount` so the copy can say how many dates went with it, exactly
   * as `EventsService` does. Unlike that path these gatherings need not form
   * one series (a host's calendar is whatever they were running), so no
   * `seriesId` is claimed — the bundle key stays null and this single row
   * stands on its own, which is correct for a single message.
   *
   * Best-effort: the cancellations have already committed, and a notification
   * failure must not fail the erasure that produced them.
   */
  private async notifyAttendeesCancelled(events: Event[]): Promise<void> {
    if (!events.length) return;
    // Soonest first, so the row names the gathering the recipient was about to
    // turn up to rather than an arbitrary one from the middle of the set.
    const ordered = [...events].sort(
      (first, second) => first.startAt.getTime() - second.startAt.getTime(),
    );
    const [soonest] = ordered;
    if (!soonest) return;
    try {
      const eventIds = ordered.map((event) => event.id);
      const [rsvps, invites] = await Promise.all([
        this.rsvps.find({
          where: {
            eventId: In(eventIds),
            status: In([
              RsvpStatus.Going,
              RsvpStatus.Maybe,
              RsvpStatus.Waitlisted,
            ]),
          },
        }),
        this.invites.find({
          where: { eventId: In(eventIds), status: EventInviteStatus.Pending },
        }),
      ]);
      const recipientIds = [
        ...new Set([
          ...rsvps.map((rsvp) => rsvp.userId),
          ...invites.map((invite) => invite.inviteeId),
        ]),
      ];
      if (!recipientIds.length) return;
      // No `actorId`: there is no acting member to name. The gathering was
      // cancelled by the platform because its host is gone.
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.EventCancelled,
        {
          eventId: soonest.id,
          eventSlug: soonest.slug,
          title: soonest.title,
          startAt: soonest.startAt.toISOString(),
          occurrenceCount: ordered.length,
        },
      );
    } catch (error) {
      this.logger.error(
        `${events.length} gathering(s) were cancelled for an erased host, but ` +
          `telling their attendees failed: ` +
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /**
   * A recurring gathering's repeat rule follows its occurrences: if any
   * unfinished occurrence went to a co-host, that member takes the series too,
   * so they can edit the schedule they are now running. A series whose
   * occurrences were all cancelled keeps no host, and the FK blanks `host_id`
   * when the user row goes.
   *
   * The occurrence selection MUST match `handleFutureGatherings`' one arm for
   * arm. `successorByEventId` is keyed by the events that method looked at, so
   * a narrower filter here would silently drop a series whose only handed-over
   * occurrence is the one currently running, leaving the new host unable to
   * edit the schedule they were just given.
   *
   * `now` is the CALLER'S instant, passed in rather than read again. Two clocks
   * inside one logical operation is a race: an occurrence that ends between the
   * two reads would be handed to a co-host by the first pass and then be
   * invisible to this one, so the series would keep a host the FK is about to
   * null. It would happen only under load and leave nothing behind to trace.
   */
  private async releaseHostedSeries(
    userId: string,
    successorByEventId: ReadonlyMap<string, string>,
    now: Date,
  ): Promise<void> {
    const hostedSeries = await this.eventSeries.find({
      where: { hostId: userId },
    });
    if (!hostedSeries.length) return;

    // The successor for a series is the one chosen for its EARLIEST unfinished
    // occurrence, so a series with different co-hosts per occurrence resolves
    // deterministically rather than by row order.
    const seriesScope = {
      seriesId: In(hostedSeries.map((series) => series.id)),
    };
    const occurrences = await this.events.find({
      where: [
        { ...seriesScope, startAt: MoreThan(now) },
        { ...seriesScope, endAt: MoreThan(now) },
      ],
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
