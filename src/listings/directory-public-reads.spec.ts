import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  Event,
  EventStatus,
  EventVenueConfirmation,
  EventVisibility,
} from '../events/entities/event.entity';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { SafeSpaceBadgeService } from '../safe-space-nominations/safe-space-badge.service';
import { ADULT_DIRECTORY_LIMIT, DirectoryService } from './directory.service';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing, SafeSpaceStatus } from './entities/listing.entity';
import {
  ListingAccessibilityAnswer,
  ListingAccessibilityAnswerMap,
} from './listing-accessibility';
import {
  DIRECTORY_CARD_HOURS_EXCEPTION_DAYS_AHEAD,
  toDirectoryCard,
} from './listing-response';
import { LISTING_TAG_GROUPS } from './listing-tags';

/**
 * The public directory reads that changed with the 2026-08-25 "Local" build:
 *
 * - LOC-02: the venue detail's `upcoming` block must never carry a gathering
 *   scoped tighter than its viewer. The endpoint is `@Public()` and the
 *   anonymous variant is CDN-cached, so a leak here reaches the open web.
 * - LOC-11/LOC-12: the card now carries opening hours and the six accessibility
 *   answers, and `access=` filters on the latter with `unknown` NEVER counting
 *   as a match.
 */

const ALL_UNKNOWN: ListingAccessibilityAnswerMap = {
  'step-free-entrance': ListingAccessibilityAnswer.Unknown,
  'wheelchair-accessible-interior': ListingAccessibilityAnswer.Unknown,
  'accessible-toilet': ListingAccessibilityAnswer.Unknown,
  'gender-neutral-toilet': ListingAccessibilityAnswer.Unknown,
  'quiet-hours': ListingAccessibilityAnswer.Unknown,
  'assistance-animals-welcome': ListingAccessibilityAnswer.Unknown,
};

/** A listing complete enough for every public response builder to read. */
function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'casa-t',
    name: 'Casa T',
    ownerId: null,
    cats: ['space'],
    hood: 'Anjos',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    blurb: 'A community house.',
    tagline: '',
    tags: [],
    price: '',
    badge: '',
    photoGallery: [],
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {
      Tue: { open: true, intervals: [{ from: '18:00', to: '23:00' }] },
    },
    hoursExceptions: [],
    hoursNote: '',
    langs: [],
    whatItIs: [],
    goodFor: [],
    services: [],
    menu: { sections: [], file: null, link: '' },
    pricingMode: 'services',
    accessibilityAnswers: ALL_UNKNOWN,
    accessibilityNote: '',
    social: {},
    address: 'R. dos Anjos 1',
    online: false,
    latitude: null,
    longitude: null,
    ownerName: '',
    ownerRole: '',
    ownerBio: '',
    visibility: 'anon',
    linkToProfile: false,
    movedToListingId: null,
    safeSpaceStatus: SafeSpaceStatus.None,
    safeSpaceTier: null,
    safeSpaceVerifier: '',
    safeSpaceReVerifiedAt: null,
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: null,
    ...overrides,
  } as unknown as Listing;
}

/** One `events` row, only the fields `toUpcomingEvent` reads. */
function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    slug: 'trans-peer-support',
    title: 'Trans peer support',
    startAt: new Date('2026-09-01T18:00:00.000Z'),
    ...overrides,
  } as unknown as Event;
}

describe('DirectoryService public reads', () => {
  let service: DirectoryService;
  let listings: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let events: { find: jest.Mock };
  let queryBuilder: Record<string, jest.Mock>;

  /** The chain `buildDirectoryQuery` builds, every link returning itself. */
  const makeQueryBuilder = () => {
    const chain: Record<string, jest.Mock> = {};
    for (const method of [
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'take',
    ]) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    chain.getMany = jest.fn().mockResolvedValue([]);
    return chain;
  };

  /** Every `andWhere(condition, params)` call, as `[condition, params]`. */
  const andWhereCalls = () =>
    (queryBuilder['andWhere'] as jest.Mock).mock.calls as [
      unknown,
      Record<string, unknown>?,
    ][];

  beforeEach(async () => {
    queryBuilder = makeQueryBuilder();
    listings = {
      findOne: jest.fn().mockResolvedValue(makeListing()),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };
    events = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectoryService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(ListingReview),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(ListingReviewHelpfulVote),
          useValue: {},
        },
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: getRepositoryToken(Event), useValue: events },
        {
          provide: getRepositoryToken(SavedItem),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: getRepositoryToken(SafeSpaceMemberVouch),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ContentModerationService,
          useValue: {
            statesFor: jest.fn().mockResolvedValue(new Map()),
            statesForAnyType: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: StorageService, useValue: {} },
        {
          provide: DataSource,
          useValue: { transaction: jest.fn() },
        },
        // The batched open-suspension lookup every public card read now makes.
        // No suspensions in these fixtures, so it answers with an empty Map.
        {
          provide: SafeSpaceBadgeService,
          useValue: {
            openSuspensionsByListing: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    service = module.get(DirectoryService);
  });

  // --- LOC-02: private gatherings must not leak onto a public venue page ----
  describe('getDirectoryBySlug upcoming events', () => {
    /** The `where` object handed to the events repository. */
    const eventsWhere = (): Record<string, unknown> => {
      const [firstCall] = events.find.mock.calls as [
        { where: Record<string, unknown> | Record<string, unknown>[] },
      ][];
      if (firstCall === undefined) return {};
      const { where } = firstCall[0];
      // The query ORs its arms; the first venue arm carries every narrowing
      // condition the venue arms share.
      return Array.isArray(where) ? (where[0] ?? {}) : where;
    };

    it('asks for public events only when the viewer is anonymous', async () => {
      await service.getDirectoryBySlug('casa-t');

      expect(eventsWhere()['visibility']).toBe(EventVisibility.Public);
    });

    it('defaults to the anonymous filter when no viewer flag is passed at all', async () => {
      // The parameter is optional, so the SAFE answer has to be the default: a
      // future caller that forgets it must under-share, never over-share.
      await service.getDirectoryBySlug('casa-t');

      expect(eventsWhere()['visibility']).not.toEqual(
        expect.arrayContaining([EventVisibility.Members]),
      );
    });

    it('never asks for invite-only, network or community gatherings, signed in or not', async () => {
      await service.getDirectoryBySlug('casa-t', true);

      // `In([...])` keeps the requested values on `_value`; a bare enum member
      // is compared directly. Flatten both shapes to one array of strings.
      const filter = eventsWhere()['visibility'] as
        string | { _value?: string[]; value?: string[] };
      const requested =
        typeof filter === 'string'
          ? [filter]
          : (filter._value ?? filter.value ?? []);

      expect(requested).toEqual(
        expect.arrayContaining([
          EventVisibility.Public,
          EventVisibility.Members,
        ]),
      );
      expect(requested).not.toContain(EventVisibility.InviteOnly);
      expect(requested).not.toContain(EventVisibility.Network);
      expect(requested).not.toContain(EventVisibility.ExtendedNetwork);
      expect(requested).not.toContain(EventVisibility.Community);
    });

    it('still restricts to published events at this listing', async () => {
      await service.getDirectoryBySlug('casa-t');

      expect(eventsWhere()['listingId']).toBe('listing-1');
      expect(eventsWhere()['status']).toBe(EventStatus.Published);
    });

    it('keeps an invite-only gathering at a listed venue out of the anonymous payload', async () => {
      // The repository is filtered in-query, so an anonymous read simply never
      // sees the row. Prove the whole path: the only rows the repository would
      // return for the anonymous filter are public ones, and the detail carries
      // exactly those.
      events.find.mockImplementation(
        (options: { where: { visibility: unknown }[] }) => {
          const publicOnly =
            options.where[0]?.visibility === EventVisibility.Public;
          return Promise.resolve(
            publicOnly
              ? [makeEvent({ id: 'event-open', slug: 'open-mic' })]
              : [
                  makeEvent({ id: 'event-open', slug: 'open-mic' }),
                  makeEvent({
                    id: 'event-private',
                    slug: 'trans-peer-support',
                  }),
                ],
          );
        },
      );

      const anonymous = await service.getDirectoryBySlug('casa-t');
      expect(anonymous.upcoming.map((event) => event.slug)).toEqual([
        'open-mic',
      ]);
      expect(JSON.stringify(anonymous)).not.toContain('trans-peer-support');
    });
  });

  // --- LOC-16: what a PENDING venue attachment does on the public page -----
  //
  // A gathering attaches itself to a business by picking it out of the
  // directory. The owner is asked, and until they answer the attachment is
  // `pending`. The decision this block pins down is where a pending
  // attachment is allowed to appear:
  //
  //  - NOT on the anonymous, CDN-cached, search-indexable variant. To a
  //    stranger that page reads as the business speaking about itself, and a
  //    party the owner never agreed to appearing there is the whole harm.
  //  - YES to a signed-in member, carrying `venueConfirmed: false`. Most
  //    listings are unclaimed or belong to somebody who may never sign in, so
  //    hiding every pending attachment until an owner acts would make real
  //    gatherings undiscoverable indefinitely. Inside the community, flagged,
  //    an unconfirmed attachment is legible as one member's claim.
  //
  // The anonymous variant therefore stays STRICTLY the narrowest one on BOTH
  // axes (public-only visibility AND confirmed-only attachments), which is
  // what makes it the safe one to hand a shared cache.
  describe('getDirectoryBySlug pending venue attachments', () => {
    const eventsWhere = (): Record<string, unknown> => {
      const [firstCall] = events.find.mock.calls as [
        { where: Record<string, unknown> | Record<string, unknown>[] },
      ][];
      if (firstCall === undefined) return {};
      const { where } = firstCall[0];
      // The query ORs its arms; the first venue arm carries every narrowing
      // condition the venue arms share.
      return Array.isArray(where) ? (where[0] ?? {}) : where;
    };

    it('asks for confirmed attachments only when the viewer is anonymous', async () => {
      await service.getDirectoryBySlug('casa-t');

      expect(eventsWhere()['venueConfirmation']).toBe(
        EventVenueConfirmation.Confirmed,
      );
    });

    it('defaults to the confirmed-only filter when no viewer flag is passed', async () => {
      // Same safe-by-default rule the visibility filter follows: a future
      // caller that forgets the flag must under-share.
      await service.getDirectoryBySlug('casa-t');

      expect(eventsWhere()['venueConfirmation']).not.toBeUndefined();
    });

    it('lets a signed-in member see pending attachments too', async () => {
      await service.getDirectoryBySlug('casa-t', true);

      expect(eventsWhere()['venueConfirmation']).toBeUndefined();
    });

    it('flags a pending attachment on the member payload rather than passing it off as the venue’s own programme', async () => {
      events.find.mockResolvedValue([
        makeEvent({
          id: 'event-confirmed',
          slug: 'open-mic',
          venueConfirmation: EventVenueConfirmation.Confirmed,
        }),
        makeEvent({
          id: 'event-pending',
          slug: 'basement-party',
          venueConfirmation: EventVenueConfirmation.Pending,
        }),
      ]);

      const member = await service.getDirectoryBySlug('casa-t', true);

      expect(
        member.upcoming.map((event) => [event.slug, event.venueConfirmed]),
      ).toEqual([
        ['open-mic', true],
        ['basement-party', false],
      ]);
    });

    it('keeps an unconfirmed gathering out of the anonymous payload entirely', async () => {
      // The repository is filtered in-query, so the anonymous read never sees
      // the row. Prove the whole path the way the LOC-02 case does.
      events.find.mockImplementation(
        (options: { where: { venueConfirmation?: unknown }[] }) => {
          const confirmedOnly =
            options.where[0]?.venueConfirmation ===
            EventVenueConfirmation.Confirmed;
          return Promise.resolve(
            confirmedOnly
              ? [
                  makeEvent({
                    id: 'event-confirmed',
                    slug: 'open-mic',
                    venueConfirmation: EventVenueConfirmation.Confirmed,
                  }),
                ]
              : [
                  makeEvent({
                    id: 'event-confirmed',
                    slug: 'open-mic',
                    venueConfirmation: EventVenueConfirmation.Confirmed,
                  }),
                  makeEvent({
                    id: 'event-pending',
                    slug: 'basement-party',
                    venueConfirmation: EventVenueConfirmation.Pending,
                  }),
                ],
          );
        },
      );

      const anonymous = await service.getDirectoryBySlug('casa-t');

      expect(anonymous.upcoming.map((event) => event.slug)).toEqual([
        'open-mic',
      ]);
      expect(JSON.stringify(anonymous)).not.toContain('basement-party');
    });
  });

  // --- "Run by": gatherings the listing's own business runs ---------------
  describe('getDirectoryBySlug run-by gatherings', () => {
    /** Every arm the events query ORs, in order. */
    const upcomingArms = (): Record<string, unknown>[] => {
      const [firstCall] = events.find.mock.calls as [
        { where: Record<string, unknown>[] },
      ][];
      return firstCall === undefined ? [] : firstCall[0].where;
    };

    it('adds a run-by pair carrying published and the anonymous tier, with no venue condition', async () => {
      await service.getDirectoryBySlug('casa-t');

      const arms = upcomingArms();
      expect(arms).toHaveLength(4);
      for (const runByArm of arms.slice(2)) {
        expect(runByArm['runByListingId']).toBe('listing-1');
        expect(runByArm['status']).toBe(EventStatus.Published);
        expect(runByArm['visibility']).toBe(EventVisibility.Public);
        expect(runByArm).not.toHaveProperty('listingId');
        expect(runByArm).not.toHaveProperty('venueConfirmation');
      }
      expect(arms[2]).toHaveProperty('startAt');
      expect(arms[3]).toHaveProperty('endAt');
    });

    it('widens the run-by pair for a member exactly as far as the venue pair', async () => {
      await service.getDirectoryBySlug('casa-t', true);

      const arms = upcomingArms();
      expect(arms[2]?.['visibility']).toEqual(arms[0]?.['visibility']);
      expect(arms[3]?.['visibility']).toEqual(arms[0]?.['visibility']);
    });

    it('keeps the confirmed-venue rule on the anonymous venue pair', async () => {
      await service.getDirectoryBySlug('casa-t');

      const arms = upcomingArms();
      expect(arms[0]?.['venueConfirmation']).toBe(
        EventVenueConfirmation.Confirmed,
      );
      expect(arms[1]?.['venueConfirmation']).toBe(
        EventVenueConfirmation.Confirmed,
      );
      expect(arms[0]?.['listingId']).toBe('listing-1');
    });

    it('still takes four, soonest first', async () => {
      await service.getDirectoryBySlug('casa-t');

      const [firstCall] = events.find.mock.calls as [
        { order: unknown; take: number },
      ][];
      expect(firstCall?.[0].order).toEqual({ startAt: 'ASC' });
      expect(firstCall?.[0].take).toBe(4);
    });

    it('lists a gathering run by and held at the listing once, as run by', async () => {
      events.find.mockResolvedValue([
        makeEvent({
          id: 'event-walk',
          slug: 'queer-history-walk',
          listingId: 'listing-1',
          runByListingId: 'listing-1',
          venueConfirmation: EventVenueConfirmation.Confirmed,
        }),
      ]);

      const anonymous = await service.getDirectoryBySlug('casa-t');

      expect(anonymous.upcoming).toHaveLength(1);
      expect(anonymous.upcoming[0]).toMatchObject({
        slug: 'queer-history-walk',
        role: 'runBy',
      });
    });

    it('reads a gathering held here and run by another business as a venue item', async () => {
      events.find.mockResolvedValue([
        makeEvent({
          listingId: 'listing-1',
          runByListingId: 'listing-other',
          venueConfirmation: EventVenueConfirmation.Confirmed,
        }),
      ]);

      const detail = await service.getDirectoryBySlug('casa-t');

      expect(detail.upcoming[0]?.role).toBe('venue');
    });
  });

  // --- LOC-12: `access=` filters on the jsonb answers, `yes` only -----------
  describe('listDirectory access filter', () => {
    /** The `accessibilityAnswers @> ...` predicate, if one was added. */
    const containmentCall = () =>
      andWhereCalls().find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('listing.accessibilityAnswers @>'),
      );

    it('adds no accessibility predicate when `access` is absent', async () => {
      await service.listDirectory({});

      expect(containmentCall()).toBeUndefined();
    });

    it('adds no accessibility predicate for an empty `access` array', async () => {
      await service.listDirectory({ access: [] });

      expect(containmentCall()).toBeUndefined();
    });

    it('requires a stored `yes`, so `unknown` is not a match', async () => {
      await service.listDirectory({ access: ['step-free-entrance'] });

      const call = containmentCall();
      expect(call).toBeDefined();
      const requirement = JSON.parse(
        String(call?.[1]?.accessRequirement),
      ) as Record<string, string>;
      expect(requirement).toEqual({ 'step-free-entrance': 'yes' });
      // The two answers that must never satisfy an access requirement.
      expect(Object.values(requirement)).not.toContain(
        ListingAccessibilityAnswer.Unknown,
      );
      expect(Object.values(requirement)).not.toContain(
        ListingAccessibilityAnswer.No,
      );
    });

    it('ANDs several requirements into one containment test', async () => {
      await service.listDirectory({
        access: ['step-free-entrance', 'accessible-toilet'],
      });

      const call = containmentCall();
      expect(JSON.parse(String(call?.[1]?.accessRequirement))).toEqual({
        'step-free-entrance': 'yes',
        'accessible-toilet': 'yes',
      });
      // ONE predicate for N requirements — that is what the GIN index serves.
      expect(
        andWhereCalls().filter(
          (each) =>
            typeof each[0] === 'string' &&
            each[0].includes('listing.accessibilityAnswers @>'),
        ),
      ).toHaveLength(1);
    });

    it('casts the requirement to jsonb so Postgres compares jsonb, not text', async () => {
      await service.listDirectory({ access: ['quiet-hours'] });

      expect(String(containmentCall()?.[0])).toContain(
        'CAST(:accessRequirement AS jsonb)',
      );
    });
  });

  describe('listDirectory owned filter', () => {
    /** The `listing.ownedBy && ...` predicate, if one was added. */
    const overlapCall = () =>
      andWhereCalls().find(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('listing.ownedBy'),
      );

    it('adds no ownedBy predicate when `owned` is absent', async () => {
      await service.listDirectory({});

      expect(overlapCall()).toBeUndefined();
    });

    it('adds no ownedBy predicate for an empty `owned` array', async () => {
      await service.listDirectory({ owned: [] });

      expect(overlapCall()).toBeUndefined();
    });

    it('matches on array overlap, so several values are an OR', async () => {
      await service.listDirectory({ owned: ['women', 'trans'] });

      const call = overlapCall();
      expect(call?.[0]).toBe('listing.ownedBy && :ownedBy');
      expect(call?.[1]).toEqual({ ownedBy: ['women', 'trans'] });
      // ONE predicate for N values: an OR, never an AND of N tests.
      expect(
        andWhereCalls().filter(
          (each) =>
            typeof each[0] === 'string' && each[0].includes('listing.ownedBy'),
        ),
      ).toHaveLength(1);
    });

    it('applies the filter in the paged query, so `total` counts only matches', async () => {
      queryBuilder['skip'] = jest.fn().mockReturnValue(queryBuilder);
      queryBuilder['getManyAndCount'] = jest.fn().mockResolvedValue([[], 0]);

      const page = await service.listDirectoryPage({
        owned: ['nonbinary'],
        page: 1,
      });

      expect(overlapCall()?.[1]).toEqual({ ownedBy: ['nonbinary'] });
      expect(queryBuilder['getManyAndCount']).toHaveBeenCalledTimes(1);
      expect(page.total).toBe(0);
    });
  });

  // --- "list your business" wizard: the curated tag vocabulary -------------
  describe('listTagVocabulary', () => {
    it('returns every curated group with its place and online tags, in order', () => {
      expect(service.listTagVocabulary()).toEqual(
        LISTING_TAG_GROUPS.map((group) => ({
          id: group.id,
          tags: [...group.tags],
          onlineTags: [...group.onlineTags],
        })),
      );
    });

    it('lists the groups in display order, from visiting to sessions', () => {
      const groupIds = service.listTagVocabulary().map((group) => group.id);

      expect(groupIds).toEqual([
        'visiting',
        'happening',
        'foodDrink',
        'pricing',
        'ordering',
        'sessions',
      ]);
    });

    it('carries the online-only groups with an empty place list', () => {
      const sessionsGroup = service
        .listTagVocabulary()
        .find((group) => group.id === 'sessions');

      expect(sessionsGroup).toEqual({
        id: 'sessions',
        tags: [],
        onlineTags: ['Free first call'],
      });
    });

    it('hands out copies, so a caller mutating the response leaves the vocabulary intact', () => {
      const [firstGroup] = service.listTagVocabulary();
      firstGroup?.tags.push('Invented tag');
      firstGroup?.onlineTags.push('Invented online tag');

      expect(LISTING_TAG_GROUPS[0]?.tags).not.toContain('Invented tag');
      expect(LISTING_TAG_GROUPS[0]?.onlineTags).not.toContain(
        'Invented online tag',
      );
    });

    it('never reads the database', () => {
      service.listTagVocabulary();

      expect(listings.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('online and 18+ reads', () => {
    const ADULT_PREDICATE = 'NOT (:adultCategory = ANY("listing"."cats"))';
    const ONLY_ADULT_PREDICATE = ':adultCategory = ANY("listing"."cats")';
    const ONLINE_PREDICATE =
      '("listing"."online" = true OR "listing"."has_online_shop" = true)';

    const predicateTexts = () => andWhereCalls().map((call) => String(call[0]));

    it('narrows to listings that sell online when online=true', async () => {
      await service.listDirectory({ online: 'true' });

      expect(predicateTexts()).toContain(ONLINE_PREDICATE);
    });

    it('adds no online predicate when the filter is absent', async () => {
      await service.listDirectory({});

      expect(predicateTexts()).not.toContain(ONLINE_PREDICATE);
    });

    it('leaves 18+ listings out of the public grid, in the query itself', async () => {
      await service.listDirectory({});

      expect(andWhereCalls()).toContainEqual([
        ADULT_PREDICATE,
        { adultCategory: 'intimacy' },
      ]);
    });

    it('keeps only 18+ listings on the members’ list, capped at 100', async () => {
      await service.listAdultDirectory({ cat: 'intimacy' });

      expect(andWhereCalls()).toContainEqual([
        ONLY_ADULT_PREDICATE,
        { adultCategory: 'intimacy' },
      ]);
      expect(predicateTexts()).not.toContain(ADULT_PREDICATE);
      expect(queryBuilder['take']).toHaveBeenCalledWith(ADULT_DIRECTORY_LIMIT);
      expect(ADULT_DIRECTORY_LIMIT).toBe(100);
    });

    it('answers an anonymous caller with the 404 a missing slug gets', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ cats: ['intimacy'], online: true }),
      );

      await expect(service.getDirectoryBySlug('casa-t')).rejects.toThrow(
        new NotFoundException('Listing not found'),
      );
    });

    it('shows a signed-in active member the 18+ detail page', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ cats: ['intimacy'], online: true }),
      );

      const detail = await service.getDirectoryBySlug('casa-t', true);

      expect(detail.isAdultsOnly).toBe(true);
    });

    it('404s the reviews and questions of an 18+ listing for an anonymous caller', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ cats: ['intimacy'], online: true }),
      );

      await expect(service.listReviews('casa-t')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.listQuestions('casa-t')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('never serves an 18+ listing as a safe space', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          cats: ['intimacy'],
          online: true,
          safeSpaceStatus: SafeSpaceStatus.Verified,
        }),
      );

      await expect(service.getSafeSpaceBySlug('casa-t')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

// --- LOC-11 / LOC-12: what the CARD now carries ---------------------------
describe('toDirectoryCard hours and accessibility', () => {
  it('carries the weekly grid and the venue timezone', () => {
    const card = toDirectoryCard(makeListing());

    expect(card.hours['Tue']?.open).toBe(true);
    expect(card.timezone).toBe('Europe/Lisbon');
  });

  it('reads an empty timezone column as null, so the client can default', () => {
    expect(toDirectoryCard(makeListing({ timezone: '' })).timezone).toBeNull();
  });

  it('carries only the near-term dated exceptions', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const card = toDirectoryCard(
      makeListing({
        hoursExceptions: [
          { date: '2026-09-09', open: false, intervals: [], note: 'yesterday' },
          { date: '2026-09-10', open: false, intervals: [], note: 'today' },
          { date: '2026-12-24', open: false, intervals: [], note: 'far off' },
        ],
      }),
      new Map(),
      now,
    );

    expect(card.hoursExceptions.map((each) => each.date)).toEqual([
      '2026-09-09',
      '2026-09-10',
    ]);
    expect(DIRECTORY_CARD_HOURS_EXCEPTION_DAYS_AHEAD).toBeGreaterThan(0);
  });

  it('carries every answer, keeping `unknown` distinct from `no`', () => {
    const card = toDirectoryCard(
      makeListing({
        accessibilityAnswers: {
          ...ALL_UNKNOWN,
          'step-free-entrance': ListingAccessibilityAnswer.Yes,
          'accessible-toilet': ListingAccessibilityAnswer.No,
        },
      }),
    );

    expect(card.accessibilityAnswers['step-free-entrance']).toBe('yes');
    expect(card.accessibilityAnswers['accessible-toilet']).toBe('no');
    expect(card.accessibilityAnswers['quiet-hours']).toBe('unknown');
    expect(Object.keys(card.accessibilityAnswers)).toHaveLength(10);
  });

  it('carries the owner’s ownedBy', () => {
    expect(
      toDirectoryCard(makeListing({ ownedBy: ['trans', 'nonbinary'] })).ownedBy,
    ).toEqual(['trans', 'nonbinary']);
  });

  it('reads a row missing the ownedBy column as [], never undefined', () => {
    const listing = makeListing();
    delete (listing as Partial<Listing>).ownedBy;

    expect(toDirectoryCard(listing).ownedBy).toEqual([]);
  });

  it('fills a row written before a question existed with `unknown`, never `yes`', () => {
    const card = toDirectoryCard(
      makeListing({
        accessibilityAnswers: {
          'step-free-entrance': ListingAccessibilityAnswer.Yes,
        } as ListingAccessibilityAnswerMap,
      }),
    );

    expect(card.accessibilityAnswers['assistance-animals-welcome']).toBe(
      'unknown',
    );
  });
});
