import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  Event,
  EventStatus,
  EventVenueConfirmation,
  EventVisibility,
} from '../events/entities/event.entity';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { Listing } from './entities/listing.entity';
import { ListingVenueEventsService } from './listing-venue-events.service';

/**
 * LOC-16, the LISTINGS half: the venue owner's confirm and detach.
 *
 * What this file pins down:
 *  - only the listing's OWNER reaches any of it (everyone else gets the same
 *    404 a non-existent ref gets, never a 403 confirming the listing exists);
 *  - detaching UNLINKS and never deletes: the gathering row survives, keeps
 *    its host, its schedule and a readable free-text venue;
 *  - detaching leaves the marker `EventsService` refuses a re-attach on;
 *  - confirming stamps the decision and is idempotent.
 */
describe('ListingVenueEventsService (LOC-16)', () => {
  let service: ListingVenueEventsService;
  let listings: { findOne: jest.Mock };
  let events: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    remove: jest.Mock;
  };
  let profiles: { find: jest.Mock; findOne: jest.Mock };

  const LISTING = {
    id: 'listing-lux',
    ref: 'QPL-2026-0001',
    slug: 'lux-cafe',
    name: 'Lux Cafe',
    ownerId: 'owner-1',
  } as unknown as Listing;

  const attachedEvent = (overrides: Partial<Event> = {}): Event =>
    ({
      id: 'event-1',
      slug: 'open-mic',
      hostId: 'host-1',
      title: 'Open mic',
      startAt: new Date('2026-09-01T18:00:00.000Z'),
      endAt: null,
      venue: null,
      listingId: LISTING.id,
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
      venueConfirmation: EventVenueConfirmation.Pending,
      venueConfirmedAt: null,
      venueOwnerNotifiedAt: new Date('2026-08-20T10:00:00.000Z'),
      venueDetachedListingId: null,
      venueDetachedAt: null,
      createdAt: new Date('2026-08-19T10:00:00.000Z'),
      ...overrides,
    }) as unknown as Event;

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(LISTING) };
    events = {
      findOne: jest.fn().mockResolvedValue(attachedEvent()),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      save: jest.fn((event: Event) => Promise.resolve(event)),
      delete: jest.fn(),
      remove: jest.fn(),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingVenueEventsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(ListingVenueEventsService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
    jest.clearAllMocks();
  });

  describe('only the listing owner gets in', () => {
    // The gate is `findOne({ where: { ref, ownerId: userId } })`, so a
    // non-owner simply matches no row. Proving it at the query level as well
    // as at the throw level means a later refactor cannot "fix" the 404 by
    // loosening the predicate.
    it('scopes the listing lookup by owner on every route', async () => {
      await service.listForOwner('QPL-2026-0001', 'owner-1');

      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: 'QPL-2026-0001', ownerId: 'owner-1' },
      });
    });

    it('404s a non-owner asking to see the attachments', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.listForOwner('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a non-owner trying to confirm', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.confirm('QPL-2026-0001', 'event-1', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(events.save).not.toHaveBeenCalled();
    });

    it('404s a non-owner trying to detach', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.detach('QPL-2026-0001', 'event-1', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(events.save).not.toHaveBeenCalled();
    });

    it('404s a gathering that is not attached to this listing', async () => {
      events.findOne.mockResolvedValue(null);

      await expect(
        service.confirm('QPL-2026-0001', 'event-9', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('confirm', () => {
    it('moves the attachment to confirmed and stamps when', async () => {
      const result = await service.confirm(
        'QPL-2026-0001',
        'event-1',
        'owner-1',
      );

      const [saved] = events.save.mock.calls[0] as [Event];
      expect(saved.venueConfirmation).toBe(EventVenueConfirmation.Confirmed);
      expect(saved.venueConfirmedAt).toBeInstanceOf(Date);
      expect(result.state).toBe('confirmed');
      expect(result.eventId).toBe('event-1');
    });

    it('is idempotent and does not rewrite an existing decision', async () => {
      const alreadyConfirmed = attachedEvent({
        venueConfirmation: EventVenueConfirmation.Confirmed,
        venueConfirmedAt: new Date('2026-08-21T09:00:00.000Z'),
      });
      events.findOne.mockResolvedValue(alreadyConfirmed);

      const result = await service.confirm(
        'QPL-2026-0001',
        'event-1',
        'owner-1',
      );

      expect(events.save).not.toHaveBeenCalled();
      expect(result.confirmedAt).toBe('2026-08-21T09:00:00.000Z');
    });

    it('stamps a grandfathered attachment the first time an owner confirms it', async () => {
      // `confirmed` with a null stamp is the pre-LOC-16 backfill: carried, but
      // never actually agreed to. An owner pressing confirm is making the
      // decision for real, so it gets recorded.
      events.findOne.mockResolvedValue(
        attachedEvent({
          venueConfirmation: EventVenueConfirmation.Confirmed,
          venueConfirmedAt: null,
        }),
      );

      await service.confirm('QPL-2026-0001', 'event-1', 'owner-1');

      const [saved] = events.save.mock.calls[0] as [Event];
      expect(saved.venueConfirmedAt).toBeInstanceOf(Date);
    });
  });

  describe('detach unlinks without deleting the gathering', () => {
    it('never deletes or removes the event row', async () => {
      await service.detach('QPL-2026-0001', 'event-1', 'owner-1');

      expect(events.delete).not.toHaveBeenCalled();
      expect(events.remove).not.toHaveBeenCalled();
      expect(events.save).toHaveBeenCalledTimes(1);
    });

    it('nulls the listing link and leaves the gathering otherwise intact', async () => {
      await service.detach('QPL-2026-0001', 'event-1', 'owner-1');

      const [saved] = events.save.mock.calls[0] as [Event];
      expect(saved.listingId).toBeNull();
      expect(saved.id).toBe('event-1');
      expect(saved.hostId).toBe('host-1');
      expect(saved.status).toBe(EventStatus.Published);
      expect(saved.startAt).toEqual(new Date('2026-09-01T18:00:00.000Z'));
    });

    it('gives the gathering a free-text venue instead of blanking where it is', async () => {
      // The host picked the venue from the directory and never typed one, so
      // nulling the link would have left the gathering with no location at all.
      await service.detach('QPL-2026-0001', 'event-1', 'owner-1');

      const [saved] = events.save.mock.calls[0] as [Event];
      expect(saved.venue).toBe('Lux Cafe');
    });

    it('keeps a free-text venue the host had already written', async () => {
      events.findOne.mockResolvedValue(
        attachedEvent({ venue: 'The back room, Lux Cafe' }),
      );

      const result = await service.detach(
        'QPL-2026-0001',
        'event-1',
        'owner-1',
      );

      expect(result.venue).toBe('The back room, Lux Cafe');
    });

    it('records the detachment so the host cannot re-attach the same venue', async () => {
      await service.detach('QPL-2026-0001', 'event-1', 'owner-1');

      const [saved] = events.save.mock.calls[0] as [Event];
      expect(saved.venueDetachedListingId).toBe(LISTING.id);
      expect(saved.venueDetachedAt).toBeInstanceOf(Date);
      // Cleared, so a LATER, different venue raises its own ask rather than
      // inheriting this one's "already asked" marker.
      expect(saved.venueOwnerNotifiedAt).toBeNull();
      expect(saved.venueConfirmation).toBe(EventVenueConfirmation.Pending);
    });
  });

  describe('listForOwner', () => {
    it('asks only for upcoming, published, page-visible gatherings', async () => {
      await service.listForOwner('QPL-2026-0001', 'owner-1');

      const calls = events.findAndCount.mock.calls as [
        { where: Record<string, unknown> },
      ][];
      const [pendingCall] = calls;
      const where = pendingCall?.[0].where ?? {};
      expect(where['listingId']).toBe(LISTING.id);
      expect(where['status']).toBe(EventStatus.Published);
      expect(where['venueConfirmation']).toBe(EventVenueConfirmation.Pending);
      // `In([...])` keeps the requested values on `_value`.
      const visibility = where['visibility'] as { _value?: string[] };
      expect(visibility._value).toEqual([
        EventVisibility.Public,
        EventVisibility.Members,
      ]);
      // A gathering nobody outside its audience may know about is never listed
      // here: it can never reach the venue's page, so there is nothing to ask.
      expect(visibility._value).not.toContain(EventVisibility.InviteOnly);
      expect(visibility._value).not.toContain(EventVisibility.Network);
    });

    it('reports true totals alongside the capped arrays', async () => {
      events.findAndCount
        .mockResolvedValueOnce([[attachedEvent()], 7])
        .mockResolvedValueOnce([[], 2]);

      const result = await service.listForOwner('QPL-2026-0001', 'owner-1');

      expect(result.counts).toEqual({ pending: 7, confirmed: 2, total: 9 });
      expect(result.pending).toHaveLength(1);
      expect(result.pending.map((row) => row.state)).toEqual(['pending']);
      expect(result.pending.map((row) => row.eventSlug)).toEqual(['open-mic']);
    });
  });
});
