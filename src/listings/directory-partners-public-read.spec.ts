import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ArrayContains, DataSource, In, Not } from 'typeorm';
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
import { DirectoryPartnerPick } from './entities/directory-partner-pick.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
  SafeSpaceStatus,
} from './entities/listing.entity';
import {
  ListingAccessibilityAnswer,
  ListingAccessibilityAnswerMap,
} from './listing-accessibility';
import { ADULT_LISTING_CATEGORY_SLUG } from './listing-categories';
import { toDirectoryCard } from './listing-response';

/**
 * The public read behind `GET /directory/partners`, and the two helpers the
 * admin partner service calls: the picker search that answers listing ids,
 * and the per-slug moderation lookup.
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

const firstListingId = '11111111-1111-4111-8111-111111111111';
const secondListingId = '22222222-2222-4222-8222-222222222222';
const thirdListingId = '33333333-3333-4333-8333-333333333333';

const firstListing = makeListing({
  id: firstListingId,
  slug: 'first-slug',
  name: 'First',
});
const secondListing = makeListing({
  id: secondListingId,
  slug: 'second-slug',
  name: 'Second',
});
const thirdListing = makeListing({
  id: thirdListingId,
  slug: 'third-slug',
  name: 'Third',
});

/** One pick as the partner read selects it: the listing id and the note. */
function makePick(
  listingId: string,
  note: string | null = null,
): Pick<DirectoryPartnerPick, 'listingId' | 'note'> {
  return { listingId, note };
}

/** The query builder links `buildDirectoryQuery` and the search chain call. */
const CHAINED_QUERY_BUILDER_METHODS = [
  'addSelect',
  'select',
  'where',
  'andWhere',
  'orderBy',
  'addOrderBy',
  'setParameters',
  'take',
] as const;

type QueryBuilderMock = Record<
  (typeof CHAINED_QUERY_BUILDER_METHODS)[number] | 'getMany',
  jest.Mock
>;

describe('DirectoryService directory partners', () => {
  let service: DirectoryService;
  let listings: {
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let queryBuilder: QueryBuilderMock;
  let dataSourceManager: { query: jest.Mock; find: jest.Mock };
  let contentModeration: { statesFor: jest.Mock; statesForAnyType: jest.Mock };

  /** The chain `buildDirectoryQuery` builds, every link returning itself. */
  const makeQueryBuilder = (): QueryBuilderMock => {
    const chain = {} as QueryBuilderMock;
    for (const method of CHAINED_QUERY_BUILDER_METHODS) {
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

  /** The `where` object handed to `listings.find`. */
  const listingsWhere = (): Record<string, unknown> => {
    const [firstCall] = listings.find.mock.calls as [
      { where: Record<string, unknown> },
    ][];
    return firstCall?.[0].where ?? {};
  };

  beforeEach(async () => {
    queryBuilder = makeQueryBuilder();
    listings = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(makeListing()),
      createQueryBuilder: jest.fn(() => queryBuilder),
      query: jest.fn().mockResolvedValue([]),
    };
    dataSourceManager = {
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
    };
    contentModeration = {
      statesFor: jest.fn().mockResolvedValue(new Map()),
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };

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
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: StorageService, useValue: {} },
        {
          provide: DataSource,
          useValue: { transaction: jest.fn(), manager: dataSourceManager },
        },
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

  describe('DirectoryService.listDirectoryPartners', () => {
    it('answers an empty list without reading listings when no partner is picked', async () => {
      dataSourceManager.find.mockResolvedValue([]);
      expect(await service.listDirectoryPartners()).toEqual([]);
      expect(listings.find).not.toHaveBeenCalled();
    });

    it('reads the picks in position order', async () => {
      await service.listDirectoryPartners();
      expect(dataSourceManager.find).toHaveBeenCalledWith(
        DirectoryPartnerPick,
        expect.objectContaining({ order: { position: 'ASC' } }),
      );
    });

    it('asks only for live, publicly listed listings among the picks, 18+ left out in-query', async () => {
      dataSourceManager.find.mockResolvedValue([
        makePick(firstListingId),
        makePick(secondListingId),
      ]);
      await service.listDirectoryPartners();
      expect(listingsWhere()).toEqual(
        expect.objectContaining({
          id: In([firstListingId, secondListingId]),
          status: ListingStatus.Live,
          operatingState: Not(ListingOperatingState.PermanentlyClosed),
          isHiddenByOwner: false,
          cats: Not(ArrayContains([ADULT_LISTING_CATEGORY_SLUG])),
        }),
      );
    });

    it('keeps the admin order and attaches each note', async () => {
      dataSourceManager.find.mockResolvedValue([
        makePick(secondListingId, 'Hosts our monthly quiz'),
        makePick(firstListingId, null),
      ]);
      listings.find.mockResolvedValue([firstListing, secondListing]);
      const result = await service.listDirectoryPartners();
      expect(result.map((card) => [card.slug, card.partnerNote])).toEqual([
        ['second-slug', 'Hosts our monthly quiz'],
        ['first-slug', null],
      ]);
    });

    it('drops a moderated partner and keeps the order of the rest', async () => {
      dataSourceManager.find.mockResolvedValue([
        makePick(firstListingId),
        makePick(secondListingId),
        makePick(thirdListingId),
      ]);
      listings.find.mockResolvedValue([
        thirdListing,
        secondListing,
        firstListing,
      ]);
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['second-slug', { hidden: true, removed: false }]]),
      );
      const result = await service.listDirectoryPartners();
      expect(result.map((card) => card.slug)).toEqual([
        'first-slug',
        'third-slug',
      ]);
    });

    it('leaves out a pick whose listing the visibility filter did not return', async () => {
      dataSourceManager.find.mockResolvedValue([
        makePick(firstListingId),
        makePick(secondListingId),
      ]);
      listings.find.mockResolvedValue([secondListing]);
      const result = await service.listDirectoryPartners();
      expect(result).toHaveLength(1);
      expect(result[0]?.slug).toBe('second-slug');
    });

    it('serves the grid card fields plus partnerNote, with no pick id, position or creator', async () => {
      dataSourceManager.find.mockResolvedValue([
        makePick(firstListingId, 'Our Friday host'),
      ]);
      listings.find.mockResolvedValue([firstListing]);
      const [card] = await service.listDirectoryPartners();
      const cardKeys = Object.keys(card ?? {});
      expect(new Set(cardKeys)).toEqual(
        new Set([...Object.keys(toDirectoryCard(firstListing)), 'partnerNote']),
      );
      expect(cardKeys).not.toContain('position');
      expect(cardKeys).not.toContain('createdById');
      expect(cardKeys).not.toContain('listingId');
      expect(card?.partnerNote).toBe('Our Friday host');
    });
  });

  describe('DirectoryService.searchListedListings', () => {
    it('returns the listing id with the slug, name, categories and neighbourhood, capped at the limit', async () => {
      queryBuilder.getMany.mockResolvedValue([firstListing]);
      const rows = await service.searchListedListings('first', 20);
      expect(queryBuilder.select).toHaveBeenCalledWith(
        expect.arrayContaining([
          'listing.id',
          'listing.slug',
          'listing.name',
          'listing.cats',
          'listing.hood',
        ]),
      );
      expect(queryBuilder.take).toHaveBeenCalledWith(20);
      expect(rows[0]?.id).toBe(firstListingId);
    });

    it('applies the grid visibility filters: live, unmoderated, closed or paused left out, 18+ left out', async () => {
      await service.searchListedListings('first', 20);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'listing.status = :status',
        { status: 'live' },
      );
      const conditions = andWhereCalls().map(([condition]) =>
        String(condition),
      );
      expect(
        conditions.some(
          (condition) =>
            condition.includes('NOT EXISTS') &&
            condition.includes('"content_moderation"'),
        ),
      ).toBe(true);
      expect(conditions).toContain('listing.isHiddenByOwner = false');
      expect(conditions).toContain(
        'listing.operatingState != :permanentlyClosedState',
      );
      expect(conditions).toContain(
        'NOT (:adultCategory = ANY("listing"."cats"))',
      );
    });

    it('leaves searchByText answering the same rows without the id', async () => {
      queryBuilder.getMany.mockResolvedValue([firstListing]);
      expect(await service.searchByText('first', 6)).toEqual([
        { slug: 'first-slug', name: 'First', cat: 'space', hood: 'Anjos' },
      ]);
    });
  });

  describe('DirectoryService.moderatedListingSlugs', () => {
    it('reports a hidden or removed listing under either moderation subject type', async () => {
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([
          ['a', { hidden: true, removed: false }],
          ['b', { hidden: false, removed: true }],
          ['c', { hidden: false, removed: false }],
        ]),
      );
      const result = await service.moderatedListingSlugs(['a', 'b', 'c']);
      expect(contentModeration.statesForAnyType).toHaveBeenCalledWith(
        ['business', 'listing'],
        ['a', 'b', 'c'],
      );
      expect(result).toEqual(new Set(['a', 'b']));
    });

    it('asks nothing for an empty list', async () => {
      const result = await service.moderatedListingSlugs([]);
      expect(result.size).toBe(0);
      expect(contentModeration.statesForAnyType).not.toHaveBeenCalled();
    });
  });
});
