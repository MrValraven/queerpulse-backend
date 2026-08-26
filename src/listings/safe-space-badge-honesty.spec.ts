import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Event } from '../events/entities/event.entity';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SafeSpaceBadgeService } from '../safe-space-nominations/safe-space-badge.service';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { DirectoryService } from './directory.service';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
  SafeSpaceStatus,
} from './entities/listing.entity';
import { ListingAccessibilityAnswer } from './listing-accessibility';
import {
  toDirectoryCard,
  toSafeSpaceCard,
  toSafeSpaceDetail,
} from './listing-response';

/**
 * A suspended safe-space badge must never reach a member as "verified".
 *
 * The badge is the platform's central trust claim: not self-declared, not a
 * sticker in a window. Three member flags (or a moderator) pause it
 * immediately, and `listings.safe_space_status` deliberately still reads
 * `verified` while that review is open, because the grant happened and is not
 * being rewritten. Every read that turns that column into a public response
 * therefore has to ask whether a suspension stands, and every one of them has
 * to ask ONCE for the whole page rather than once per row.
 *
 * These specs pin all three halves of that: the mappers, the list/count, and
 * the query economics.
 */

const ALL_UNKNOWN = {
  'step-free-entrance': ListingAccessibilityAnswer.Unknown,
  'wheelchair-accessible-interior': ListingAccessibilityAnswer.Unknown,
  'accessible-toilet': ListingAccessibilityAnswer.Unknown,
  'gender-neutral-toilet': ListingAccessibilityAnswer.Unknown,
  'quiet-hours': ListingAccessibilityAnswer.Unknown,
  'assistance-animals-welcome': ListingAccessibilityAnswer.Unknown,
};

/** A badged listing, complete enough for every public response builder. */
function makeBadgedListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'casa-t',
    name: 'Casa T',
    ownerId: null,
    cats: ['bar'],
    hood: 'Anjos',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    blurb: 'A community house.',
    tagline: '',
    tags: ['bar'],
    price: '',
    badge: '',
    photoGallery: [],
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {},
    hoursExceptions: [],
    hoursNote: '',
    langs: [],
    whatItIs: [],
    goodFor: [],
    services: [],
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
    status: ListingStatus.Live,
    isHiddenByOwner: false,
    operatingState: ListingOperatingState.Open,
    safeSpaceStatus: SafeSpaceStatus.Verified,
    safeSpaceTier: 1,
    safeSpaceVerifier: 'Mod team, 3 member visits',
    // Granted this month, so nothing is due for its annual re-review unless a
    // test says otherwise.
    safeSpaceReVerifiedAt: '2026-08-01',
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: null,
    ...overrides,
  } as unknown as Listing;
}

// --- 1. The mappers ------------------------------------------------------

describe('a suspended badge never serialises as verified', () => {
  it('reports `suspended` on a directory card, not `verified`', () => {
    const card = toDirectoryCard(
      makeBadgedListing(),
      new Map(),
      undefined,
      null,
      true,
    );
    expect(card.safeSpaceStatus).toBe('suspended');
    expect(card.safeSpaceStatus).not.toBe('verified');
  });

  it('still reports `verified` when no suspension stands', () => {
    const card = toDirectoryCard(makeBadgedListing());
    expect(card.safeSpaceStatus).toBe('verified');
  });

  it('leaves a listing with no badge alone', () => {
    const card = toDirectoryCard(
      makeBadgedListing({ safeSpaceStatus: SafeSpaceStatus.None }),
      new Map(),
      undefined,
      null,
      true,
    );
    // A suspension cannot invent a badge to suspend.
    expect(card.safeSpaceStatus).toBe('none');
  });

  it('marks the safe-space card and detail as suspended', () => {
    const card = toSafeSpaceCard(makeBadgedListing(), [], true);
    expect(card.isBadgeSuspended).toBe(true);
    const detail = toSafeSpaceDetail(makeBadgedListing(), [], [], true);
    expect(detail.isBadgeSuspended).toBe(true);
  });

  it('does not call a suspended badge due for re-review', () => {
    // Granted over a year ago AND suspended: the open review supersedes the
    // annual one, so the card must not also claim a re-review is what is
    // pending.
    const stale = makeBadgedListing({ safeSpaceReVerifiedAt: '2024-01-01' });
    expect(toSafeSpaceCard(stale, [], true).isBadgeDueForReReview).toBe(false);
    expect(
      toDirectoryCard(stale, new Map(), undefined, null, true)
        .isBadgeDueForReReview,
    ).toBe(false);
  });

  it('flags a badge that has been speaking for over a year', () => {
    const stale = makeBadgedListing({ safeSpaceReVerifiedAt: '2024-01-01' });
    expect(toSafeSpaceCard(stale, []).isBadgeDueForReReview).toBe(true);
    // A due re-review does NOT take the badge down.
    expect(toDirectoryCard(stale).safeSpaceStatus).toBe('verified');
    expect(toDirectoryCard(stale).isBadgeDueForReReview).toBe(true);
  });
});

// --- 2 + 3. The service reads --------------------------------------------

describe('DirectoryService safe-space badge suspension', () => {
  let service: DirectoryService;
  let listings: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let reviews: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let openSuspensionsByListing: jest.Mock;
  let directoryQueryBuilder: Record<string, jest.Mock>;
  let ratingsQueryBuilder: Record<string, jest.Mock>;

  /** A chain whose every link returns itself. */
  const makeChain = (methods: string[], terminal: string, result: unknown) => {
    const chain: Record<string, jest.Mock> = {};
    for (const method of methods) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }
    chain[terminal] = jest.fn().mockResolvedValue(result);
    return chain;
  };

  /** Every `andWhere(condition)` the directory query received, as strings. */
  const directoryConditions = () =>
    (
      (directoryQueryBuilder['andWhere'] as jest.Mock).mock.calls as unknown[][]
    ).map((call) => String(call[0]));

  beforeEach(async () => {
    directoryQueryBuilder = makeChain(
      ['where', 'andWhere', 'orderBy', 'addOrderBy', 'take'],
      'getMany',
      [],
    );
    ratingsQueryBuilder = makeChain(
      ['select', 'addSelect', 'where', 'andWhere', 'groupBy'],
      'getRawMany',
      [],
    );
    listings = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => directoryQueryBuilder),
    };
    reviews = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => ratingsQueryBuilder),
    };
    openSuspensionsByListing = jest.fn().mockResolvedValue(new Map());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectoryService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingReview), useValue: reviews },
        { provide: getRepositoryToken(ListingReviewHelpfulVote), useValue: {} },
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
        {
          provide: getRepositoryToken(Event),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
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
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: SafeSpaceBadgeService,
          useValue: { openSuspensionsByListing },
        },
      ],
    }).compile();
    service = module.get(DirectoryService);
  });

  // --- The list and its counts -------------------------------------------

  describe('listSafeSpaces', () => {
    const badgedPair = () => [
      makeBadgedListing({ id: 'listing-1', slug: 'casa-t', name: 'Casa T' }),
      makeBadgedListing({ id: 'listing-2', slug: 'purex', name: 'Purex' }),
    ];

    it('drops a suspended space from `verified` and from `stats.verified`', async () => {
      listings.find.mockResolvedValue(badgedPair());
      openSuspensionsByListing.mockResolvedValue(
        new Map([['listing-2', { id: 'suspension-1' }]]),
      );

      const result = await service.listSafeSpaces();

      expect(result.verified.map((card) => card.slug)).toEqual(['casa-t']);
      expect(result.stats.verified).toBe(1);
      // It is suspended, not removed. Nothing was taken away, so it must not
      // be reported under the removed column either.
      expect(result.removed).toHaveLength(0);
      expect(result.stats.removed).toBe(0);
    });

    it('keeps a suspended space out of the review aggregate', async () => {
      listings.find.mockResolvedValue(badgedPair());
      openSuspensionsByListing.mockResolvedValue(
        new Map([['listing-2', { id: 'suspension-1' }]]),
      );
      ratingsQueryBuilder['getRawMany']!.mockResolvedValue([
        { listingId: 'listing-1', reviewCount: '2', starSum: '9' },
      ]);

      const result = await service.listSafeSpaces();

      // The suspended listing's id is never even asked about, so its reviews
      // cannot reach `stats.reviews`.
      const [, parameters] = ratingsQueryBuilder['where']!.mock.calls[0] as [
        string,
        { verifiedListingIds: string[] },
      ];
      expect(parameters.verifiedListingIds).toEqual(['listing-1']);
      expect(result.stats.reviews).toBe(2);
    });

    it('lists every badged space when nothing is suspended', async () => {
      listings.find.mockResolvedValue(badgedPair());

      const result = await service.listSafeSpaces();

      expect(result.verified.map((card) => card.slug)).toEqual([
        'casa-t',
        'purex',
      ]);
      expect(result.stats.verified).toBe(2);
    });

    it('resolves the whole page of suspensions in ONE query', async () => {
      listings.find.mockResolvedValue(badgedPair());

      await service.listSafeSpaces();

      expect(openSuspensionsByListing).toHaveBeenCalledTimes(1);
      expect(openSuspensionsByListing).toHaveBeenCalledWith([
        'listing-1',
        'listing-2',
      ]);
    });
  });

  // --- The grid ----------------------------------------------------------

  describe('listDirectory', () => {
    it('asks about a page of badges once, not once per row', async () => {
      const page = Array.from({ length: 25 }, (unused, index) =>
        makeBadgedListing({
          id: `listing-${index}`,
          slug: `space-${index}`,
        }),
      );
      directoryQueryBuilder['getMany']!.mockResolvedValue(page);

      await service.listDirectory({});

      expect(openSuspensionsByListing).toHaveBeenCalledTimes(1);
      const [askedListingIds] = openSuspensionsByListing.mock
        .calls[0] as unknown as [string[]];
      expect(askedListingIds).toHaveLength(25);
    });

    it('costs no query at all when no card carries a badge', async () => {
      directoryQueryBuilder['getMany']!.mockResolvedValue([
        makeBadgedListing({ safeSpaceStatus: SafeSpaceStatus.None }),
      ]);

      await service.listDirectory({});

      expect(openSuspensionsByListing).not.toHaveBeenCalled();
    });

    it('serialises the suspended card as `suspended`', async () => {
      directoryQueryBuilder['getMany']!.mockResolvedValue([
        makeBadgedListing({ id: 'listing-1' }),
        makeBadgedListing({ id: 'listing-2', slug: 'purex' }),
      ]);
      openSuspensionsByListing.mockResolvedValue(
        new Map([['listing-2', { id: 'suspension-1' }]]),
      );

      const cards = await service.listDirectory({});

      expect(cards[0]!.safeSpaceStatus).toBe('verified');
      expect(cards[1]!.safeSpaceStatus).toBe('suspended');
    });

    it('excludes suspended badges from the `safe=verified` filter in-query', async () => {
      await service.listDirectory({ safe: 'verified' });

      const suspensionPredicate = directoryConditions().find((condition) =>
        condition.includes('safe_space_badge_suspensions'),
      );
      expect(suspensionPredicate).toBeDefined();
      // An anti-join, so a suspended row is filtered OUT rather than in. Doing
      // it in-query is what keeps `listDirectoryPage`'s `total` honest.
      expect(suspensionPredicate).toContain('NOT EXISTS');
      expect(suspensionPredicate).toContain('"lifted_at" IS NULL');
    });

    it('does not boost a suspended badge to the top of the grid', async () => {
      await service.listDirectory({});

      const [ordering] = directoryQueryBuilder['orderBy']!.mock.calls[0] as [
        string,
      ];
      expect(ordering).toContain('safe_space_badge_suspensions');
      expect(ordering).toContain('NOT EXISTS');
    });
  });

  // --- The detail --------------------------------------------------------

  describe('getSafeSpaceBySlug', () => {
    it('keeps the page resolving and says the badge is suspended', async () => {
      listings.findOne.mockResolvedValue(makeBadgedListing());
      openSuspensionsByListing.mockResolvedValue(
        new Map([['listing-1', { id: 'suspension-1' }]]),
      );

      const detail = await service.getSafeSpaceBySlug('casa-t');

      expect(detail.status).toBe('verified');
      expect((detail as { isBadgeSuspended: boolean }).isBadgeSuspended).toBe(
        true,
      );
      expect(openSuspensionsByListing).toHaveBeenCalledTimes(1);
    });
  });
});
