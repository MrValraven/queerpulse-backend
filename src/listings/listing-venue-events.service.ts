import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Event,
  EventStatus,
  EventVenueConfirmation,
  EventVisibility,
} from '../events/entities/event.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  DetachedVenueEventDTO,
  ListingVenueEventsDTO,
  VenueEventAttachmentDTO,
  toVenueEventAttachmentDTO,
} from './dto/venue-event-attachment.dto';
import { Listing } from './entities/listing.entity';

/**
 * How many attachments of each state one response carries. The `counts` block
 * is always the true total, so a venue sitting on 200 pending gatherings
 * reports 200 and ships the soonest 50. Same reasoning and same size as
 * `OWNER_PENDING_ITEM_CAP`.
 */
export const VENUE_EVENT_ITEM_CAP = 50;

/**
 * LOC-16: the venue owner's side of an event-to-listing attachment.
 *
 * Until this existed, any member creating a gathering could pick any live,
 * operating, non-hidden directory listing as its venue, and that was the whole
 * check. The owner was never asked, never told, and could not detach. A bar
 * owner could wake up to a party on their business's page.
 *
 * The state itself lives on `events` (`venue_confirmation` and its four
 * siblings) rather than in a join table. See `EventVenueConfirmation` for
 * that argument. This service is the only place it is decided.
 *
 * OWNER ONLY, not owner-or-co-manager, and that is deliberate. Every other
 * `:ref`-scoped route on `ListingsController` admits a co-manager because it
 * is running the business day to day; consenting to have the business's name
 * attached to a stranger's event is closer to the acts `loadOwnedOr404`
 * already fences off (deleting the page, anything touching ownership). The
 * decision is the owner's to make, and it is one line to widen later if the
 * product decides a co-manager should share it.
 *
 * SCOPE. This surface only ever carries PUBLISHED gatherings scoped `public`
 * or `members`, starting from now. Those are the only ones the venue's public
 * page can ever show, so they are the only ones there is anything to consent
 * to. A gathering scoped `invite_only`, `network`, `extended_network` or
 * `community` is invisible here on purpose: surfacing it would disclose a
 * private gathering to somebody outside its audience in the name of asking
 * about a page appearance that could never happen.
 *
 * Kept as its own service rather than folded into `ListingsService` for the
 * same reason `ListingOwnerPendingService` is: it reads and writes a table
 * (`events`) that the listings domain does not own, and `ListingsService` is
 * already the largest class here. It follows the same file-local
 * `loadOwnedOr404` copy convention those siblings document.
 */
@Injectable()
export class ListingVenueEventsService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    // Registered on `ListingsModule` already, for `DirectoryService`'s
    // "upcoming events at this venue" read. The events domain itself still
    // lives in `EventsModule`.
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  /** The visibility tiers that can reach a venue's public page, and therefore
   *  the only ones this surface has any business showing or asking about. */
  private static readonly PAGE_VISIBLE_TIERS = [
    EventVisibility.Public,
    EventVisibility.Members,
  ];

  /**
   * OWNER ONLY: every upcoming gathering that names this business as its
   * venue, split into the ones still awaiting the owner's decision and the
   * ones already carried on the public page.
   *
   * Both reads are single-table `findAndCount`s with no join, so neither can
   * hit the `.skip()/.take()`-with-a-joined-ORDER-BY trap; `take` bounds the
   * rows while the count stays the full total. Hosts are resolved in one
   * batched profile lookup across both arrays.
   *
   * Soonest first, unlike the newest-first owner pending inbox: an owner
   * deciding about gatherings at their venue is working against a calendar,
   * and the one on Friday is the one that matters.
   */
  async listForOwner(
    ref: string,
    userId: string,
  ): Promise<ListingVenueEventsDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    const shared = {
      listingId: listing.id,
      status: EventStatus.Published,
      startAt: MoreThanOrEqual(new Date()),
      visibility: In(ListingVenueEventsService.PAGE_VISIBLE_TIERS),
    };

    const [[pendingRows, pendingCount], [confirmedRows, confirmedCount]] =
      await Promise.all([
        this.events.findAndCount({
          where: {
            ...shared,
            venueConfirmation: EventVenueConfirmation.Pending,
          },
          order: { startAt: 'ASC' },
          take: VENUE_EVENT_ITEM_CAP,
        }),
        this.events.findAndCount({
          where: {
            ...shared,
            venueConfirmation: EventVenueConfirmation.Confirmed,
          },
          order: { startAt: 'ASC' },
          take: VENUE_EVENT_ITEM_CAP,
        }),
      ]);

    const hosts = await this.hostsByUserId([...pendingRows, ...confirmedRows]);
    const toDTO = (event: Event): VenueEventAttachmentDTO =>
      toVenueEventAttachmentDTO(
        event,
        event.hostId ? hosts.get(event.hostId) : undefined,
      );

    return {
      counts: {
        pending: pendingCount,
        confirmed: confirmedCount,
        total: pendingCount + confirmedCount,
      },
      pending: pendingRows.map(toDTO),
      confirmed: confirmedRows.map(toDTO),
    };
  }

  /**
   * OWNER ONLY: yes, this gathering may say it is happening here.
   *
   * Idempotent: confirming an already-confirmed attachment returns the same
   * row rather than 409ing, and does NOT restamp `venueConfirmedAt`, so a
   * double-click cannot rewrite when the decision was actually made. The one
   * case where the stamp IS written over an existing `confirmed` state is a
   * grandfathered attachment (confirmed with a null stamp): an owner
   * confirming one of those is making the decision for real, for the first
   * time, and the stamp should record it.
   */
  async confirm(
    ref: string,
    eventId: string,
    userId: string,
  ): Promise<VenueEventAttachmentDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    const event = await this.loadAttachedEventOr404(listing.id, eventId);

    if (
      event.venueConfirmation !== EventVenueConfirmation.Confirmed ||
      event.venueConfirmedAt === null
    ) {
      event.venueConfirmation = EventVenueConfirmation.Confirmed;
      event.venueConfirmedAt = new Date();
      await this.events.save(event);
    }

    const host = event.hostId
      ? await this.profiles.findOne({ where: { userId: event.hostId } })
      : null;
    return toVenueEventAttachmentDTO(event, host ?? undefined);
  }

  /**
   * OWNER ONLY: no, take my business's name off this.
   *
   * DETACHING NEVER DELETES THE GATHERING. It unlinks the venue and nothing
   * else: the gathering, its RSVPs, its announcements and its host are
   * untouched, and it simply stops appearing on this business's page and stops
   * linking to it. A venue owner has a say over their own page, never over
   * whether somebody else's event goes ahead.
   *
   * The gathering keeps a readable location. `listing_id` goes to null, and if
   * the host never filled in the free-text `venue` field (because they picked
   * the venue from the directory instead) the business's name is copied into
   * it on the way out. Losing the link must not turn "Casa T, Friday 20:00"
   * into "Friday 20:00".
   *
   * `venue_detached_listing_id` is what makes this stick: `EventsService`
   * refuses to re-attach that listing to that gathering, so the host cannot
   * undo the owner's decision by pressing the venue picker again.
   */
  async detach(
    ref: string,
    eventId: string,
    userId: string,
  ): Promise<DetachedVenueEventDTO> {
    const listing = await this.loadOwnedOr404(ref, userId);
    const event = await this.loadAttachedEventOr404(listing.id, eventId);

    const detachedAt = new Date();
    const hasFreeTextVenue =
      event.venue !== null && event.venue.trim().length > 0;
    event.venue = hasFreeTextVenue ? event.venue : listing.name;
    event.listingId = null;
    event.venueConfirmation = EventVenueConfirmation.Pending;
    event.venueConfirmedAt = null;
    // Cleared so that a LATER, different venue raises its own ask rather than
    // inheriting this one's "already asked" marker.
    event.venueOwnerNotifiedAt = null;
    event.venueDetachedListingId = listing.id;
    event.venueDetachedAt = detachedAt;
    const saved = await this.events.save(event);

    return {
      eventId: saved.id,
      eventSlug: saved.slug,
      state: 'detached',
      detachedAt: detachedAt.toISOString(),
      venue: saved.venue,
    };
  }

  /** The gathering, scoped to THIS listing. A gathering that is not attached
   *  here (or never was) is a 404 rather than a 403: an owner has no business
   *  learning, from this endpoint, that some uuid is an event at all. */
  private async loadAttachedEventOr404(
    listingId: string,
    eventId: string,
  ): Promise<Event> {
    const event = await this.events.findOne({
      where: {
        id: eventId,
        listingId,
        status: EventStatus.Published,
        visibility: In(ListingVenueEventsService.PAGE_VISIBLE_TIERS),
      },
    });
    if (!event) {
      throw new NotFoundException('Gathering not found at this venue');
    }
    return event;
  }

  /** One batched profile lookup for every host across both arrays. */
  private async hostsByUserId(events: Event[]): Promise<Map<string, Profile>> {
    const hostIds = [
      ...new Set(
        events
          .map((event) => event.hostId)
          .filter((hostId): hostId is string => hostId !== null),
      ),
    ];
    if (hostIds.length === 0) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(hostIds) },
    });
    return new Map(profiles.map((profile) => [profile.userId, profile]));
  }

  /** Mirrors `ListingsService.loadOwnedOr404`: only the listing's OWNER gets
   *  in, and everyone else gets the same 404 a non-existent ref gets rather
   *  than a 403 confirming the listing exists. Kept as a local copy, the same
   *  call `ListingOwnerPendingService` and `ListingClaimsService` make for
   *  their own gate copies. */
  private async loadOwnedOr404(ref: string, userId: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { ref, ownerId: userId },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}
