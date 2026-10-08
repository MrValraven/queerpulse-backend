import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, MoreThan, Not } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { ReportsService } from '../reports/reports.service';
import {
  foldedHaystack,
  foldedSearchTerm,
  LISTING_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { CreateListingDto } from './dto/create-listing.dto';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { Profile } from '../users/entities/profile.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
  SafeSpaceStatus,
} from './entities/listing.entity';
import { emptyAccessibilityAnswers } from './listing-accessibility';
import { emptyListingOnlineDetails } from './listing-online-details';
import { emptyListingMobileDetails } from './listing-mobile-details';
import { ListingCoManagersService } from './listing-co-managers.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { ListingsService } from './listings.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
// Includes the search/counts additions (`leftJoin`/`andWhere`/`select`/
// `addSelect`/`groupBy`/`getRawMany`) `listQueue`'s search+counts (item #8/#9)
// need on top of the original pagination chain. `getManyAndCount`/
// `getRawMany` are declared explicitly (not just via the index signature) so
// a test can reassign their resolved value with `noUncheckedIndexedAccess`
// on without an `| undefined` false positive.
interface QueryBuilderStub extends Record<string, jest.Mock> {
  getManyAndCount: jest.Mock;
  getRawMany: jest.Mock;
}

const qbStub = (): QueryBuilderStub => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'where',
    'andWhere',
    'leftJoin',
    'orderBy',
    'skip',
    'take',
    'select',
    'addSelect',
    'groupBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb as QueryBuilderStub;
};

// Stand-in for the `EntityManager` `dataSource.transaction(...)` hands the
// callback in `setStatus`/`removeByModerator`/`bulkSetStatus`/`bulkRemove`.
// `save` supports both call shapes the real service uses:
// `manager.save(listingInstance)` (one arg — the `Listing` itself, mirrors
// `listings.save`'s "synthesize generated columns" precedent) and
// `manager.save(EntityClass, partialObject)` (two args — a moderation-event
// write). `getRepository` always returns the `listings` mock, the only
// entity the bulk methods fetch a manager-scoped repository for.
//
// Built ONCE per test (`beforeEach` assigns it to the outer `transactionManager`
// and `dataSource.transaction` always hands the SAME instance to the
// callback) rather than fresh inside the `dataSource.transaction` mock body —
// a fresh-per-call manager is unobservable from a test, so `manager.save`
// assertions on moderation-event writes would silently check nothing.
const buildTransactionManager = (listingsRepo: Record<string, jest.Mock>) => {
  const manager = {
    save: jest.fn((first: unknown, second?: object) => {
      if (second !== undefined) {
        return Promise.resolve({ id: 'event-1', ...second });
      }
      return Promise.resolve({
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...(first as object),
      });
    }),
    remove: jest.fn((entity: object) => Promise.resolve(entity)),
    getRepository: jest.fn(() => listingsRepo),
  };
  return manager;
};

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  ownerId: 'owner-1',
  createdByStaffId: null,
  suggestedByUserId: null,
  status: ListingStatus.Review,
  path: 'claim',
  verify: '',
  name: 'Lux Café',
  cats: [],
  hood: 'Arroios',
  city: '',
  timezone: '',
  badge: '',
  evidence: '',
  ownedBy: [],
  price: '',
  blurb: '',
  tagline: '',
  whatItIs: [],
  tags: [],
  goodFor: [],
  langs: [],
  online: false,
  address: '',
  geocoded: false,
  latitude: null,
  longitude: null,
  hours: {},
  hoursNote: '',
  hoursExceptions: [],
  social: { instagram: '', website: '', email: '', phone: '' },
  photoGallery: [],
  // LEGACY derived mirror of the first four `photoGallery` entries.
  photos: { wide: '', d1: '', d2: '', vibe: '' },
  alt: { wide: '', d1: '', d2: '', vibe: '' },
  rel: '',
  ownerName: '',
  ownerRole: '',
  ownerBio: '',
  visibility: 'public',
  linkToProfile: false,
  contactEmail: '',
  notify: [],
  consentOuting: false,
  consentGuide: false,
  queerOwnedVerified: false,
  isPartneredWithQueerpulse: false,
  spaceType: '',
  capacity: null,
  hostNote: '',
  safeSpaceStatus: SafeSpaceStatus.None,
  safeSpaceTier: null,
  safeSpaceVerifier: '',
  safeSpaceReVerifiedAt: null,
  safeSpaceSub: '',
  safeSpacePromises: [],
  safeSpaceVouches: [],
  safeSpaceRemoval: null,
  operatingState: ListingOperatingState.Open,
  operatingStateNote: '',
  operatingStateSetAt: null,
  movedToAddress: '',
  movedToListingId: null,
  detailsConfirmedAt: null,
  accessibilityAnswers: emptyAccessibilityAnswers(),
  accessibilityNote: '',
  services: [],
  menu: { sections: [], file: null, link: '' },
  pricingMode: 'services',
  hasOnlineShop: false,
  onlineDetails: emptyListingOnlineDetails(),
  shopItems: [],
  mobile: false,
  mobileDetails: emptyListingMobileDetails(),
  queerOwnedVerifier: '',
  queerOwnedReVerifiedAt: null,
  queerOwnedBasis: '',
  queerOwnedExpiresAt: null,
  affirmingBaselineAcceptedAt: null,
  isHiddenByOwner: false,
  ownerHiddenAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/**
 * A `findOne` that scopes by owner exactly as the real repository does.
 * `loadOwnedOr404` puts the ownership check IN the query (`where: { ref,
 * ownerId }`), so a caller who does not own the listing gets no row at all and
 * the service answers 404 — deliberately not confirming that the ref exists.
 * Passing this rather than a bare `mockResolvedValue` is what keeps those
 * tests proving the scope instead of assuming it.
 */
const scopeFindOneToOwner = (
  findOne: jest.Mock,
  ownerId: string,
  listing: Listing,
) =>
  findOne.mockImplementation((options?: { where?: { ownerId?: string } }) =>
    Promise.resolve(
      options?.where?.ownerId === undefined || options.where.ownerId === ownerId
        ? listing
        : null,
    ),
  );

describe('ListingsService', () => {
  let service: ListingsService;
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock; findOne: jest.Mock };
  let reviews: { findOne: jest.Mock; save: jest.Mock };
  let moderationEvents: {
    save: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    findOne: jest.Mock;
  };
  let questions: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  // The PUBLIC Q&A table, deliberately a separate repo mock from `questions`
  // above (the moderator-to-submitter channel) so a test that confuses the two
  // fails rather than passing by accident.
  let publicQuestions: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let messaging: { deliverEnquiry: jest.Mock };
  let notifications: { create: jest.Mock };
  // PRD-47: the shared "the subject answered your review" emit, which
  // `replyToReview` calls. Mocked rather than exercised end to end, so
  // these tests assert on the NOTICE this service composes; the notifier's
  // own guards live in `submissions/`.
  let reviewReplies: { notifyReviewReplied: jest.Mock };
  let dataSource: {
    query: jest.Mock;
    transaction: jest.Mock;
    getRepository: jest.Mock;
  };
  // The `ListingCoManager` repository `getOwnerListingHistory` reaches through
  // `dataSource.getRepository` for the team's accepted-seat member ids.
  let coManagerSeats: { find: jest.Mock };
  let coManagers: {
    isActiveCoManager: jest.Mock;
    listingIdsCoManagedBy: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };
  let reports: { create: jest.Mock };
  // The stub `EntityManager` every `dataSource.transaction(...)` call in a
  // given test is handed — see `buildTransactionManager`'s doc comment for
  // why this must be a single instance rather than built fresh per call.
  let transactionManager: ReturnType<typeof buildTransactionManager>;

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      // Backs `bulkSetStatus`/`bulkRemove`'s single batched prefetch
      // (`find({ where: { ref: In(refs) } })`) instead of one `findOne` per
      // ref.
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns so a mapper reading them off a
      // `save()` result never sees `undefined` (mirrors
      // `partners.service.spec.ts`'s identical precedent). `id` defaults to
      // 'listing-new' only when `v` does not already carry one (every call
      // outside `create` passes an already-loaded entity with a real id),
      // which is what proves the admin-queue announce below fires with the
      // row `save()` actually produced rather than one it started with.
      save: jest.fn((v: object) =>
        Promise.resolve({
          id: 'listing-new',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    reviews = {
      findOne: jest.fn(),
      save: jest.fn((v: object) => Promise.resolve(v)),
    };
    moderationEvents = {
      save: jest.fn((v: object) => Promise.resolve({ id: 'event-1', ...v })),
      find: jest.fn().mockResolvedValue([]),
      // Backs `getOwnerListingHistory`'s paginated read (the admin
      // `getListingHistory` still uses the unpaginated `find`).
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      // Backs `getOwnerListingHistory`'s latest-transfer read. `null` means
      // the listing was never transferred.
      findOne: jest.fn().mockResolvedValue(null),
    };
    questions = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: object) =>
        Promise.resolve({
          id: 'question-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
    };
    publicQuestions = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: object) =>
        Promise.resolve({
          id: 'public-question-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...v,
        }),
      ),
      count: jest.fn().mockResolvedValue(0),
    };
    messaging = { deliverEnquiry: jest.fn() };
    notifications = { create: jest.fn() };
    reviewReplies = { notifyReviewReplied: jest.fn() };
    coManagers = {
      isActiveCoManager: jest.fn().mockResolvedValue(false),
      listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    reports = { create: jest.fn() };
    transactionManager = buildTransactionManager(listings);
    coManagerSeats = { find: jest.fn().mockResolvedValue([]) };
    dataSource = {
      getRepository: jest.fn(() => coManagerSeats),
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
      // `setStatus`/`removeByModerator`/`bulkSetStatus`/`bulkRemove` all run
      // their writes through `dataSource.transaction(...)` — invoke the
      // callback with the single, per-test `transactionManager` stub (scoped
      // to the `listings` mock) rather than a real transaction, so a test can
      // assert on `transactionManager.save`/`.remove` afterward.
      transaction: jest.fn(
        (work: (manager: EntityManager) => Promise<unknown>) =>
          work(transactionManager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(ListingReview), useValue: reviews },
        {
          provide: getRepositoryToken(ListingModerationEvent),
          useValue: moderationEvents,
        },
        { provide: getRepositoryToken(ListingQuestion), useValue: questions },
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: publicQuestions,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: MessagingService, useValue: messaging },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        // Item #13: disputes + owner-notify tasks file through the shared
        // reports pipeline. A create reaches `create` only for a suggestion,
        // so a bare mock suffices for the existing cases.
        { provide: ReportsService, useValue: reports },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        // The second management gate's data source. Every case in THIS file is
        // an owner or a stranger, so the default answer is "no seat" and the
        // owner-vs-stranger behaviour under test is unchanged. The co-manager
        // boundary itself is covered in
        // `listing-co-manager-permissions.spec.ts`, where the answer is varied
        // deliberately.
        { provide: ListingCoManagersService, useValue: coManagers },
        { provide: ReviewReplyNotifier, useValue: reviewReplies },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
        // `ListingsService` takes it for the safe-space visit count; no case
        // here reaches that read.
        {
          provide: SafeSpaceVisitsService,
          useValue: { countIndependentVisits: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(ListingsService);
    // The listing mapper resolves photos through `toImageUrl`, which throws
    // `Service temporarily unavailable` when the base was never wired. Only
    // storage-key fixtures reach it (the M1 foreign-photo cases).
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('create', () => {
    it('allocates a QPL-<year>-<seq> ref and a slug, defaulting to Review', async () => {
      const dto = { name: 'Lux Café' } as CreateListingDto;
      const result = await service.create('owner-1', dto);

      const year = new Date().getFullYear();
      expect(result.ref).toBe(`QPL-${year}-0001`);
      expect(result.slug).toBe('lux-cafe');
      expect(result.status).toBe(ListingStatus.Review);
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-1',
          status: ListingStatus.Review,
          name: 'Lux Café',
        }),
      );
    });

    it('defaults every optional draft field so nothing is undefined', async () => {
      await service.create('owner-1', { name: 'Lux Café' } as CreateListingDto);

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          cats: [],
          tags: [],
          social: { instagram: '', website: '', email: '', phone: '' },
          photos: { wide: '', d1: '', d2: '', vibe: '' },
          consentOuting: false,
        }),
      );
    });

    it('stores the owner’s ownedBy in canonical order and returns it', async () => {
      const result = await service.create('owner-1', {
        name: 'Lux Café',
        ownedBy: ['nonbinary', 'trans'],
      } as CreateListingDto);

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ ownedBy: ['trans', 'nonbinary'] }),
      );
      expect(result.ownedBy).toEqual(['trans', 'nonbinary']);
    });

    it('stores an empty ownedBy when the body leaves it out', async () => {
      const result = await service.create('owner-1', {
        name: 'Lux Café',
      } as CreateListingDto);

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ ownedBy: [] }),
      );
      expect(result.ownedBy).toEqual([]);
    });

    // A suggester cannot declare the owner's gender or racial identity for
    // them, so the suggest path blanks it with the other owner-personal
    // answers.
    it('stores none of a suggester’s ownedBy', async () => {
      const result = await service.create('member-1', {
        name: 'Lux Café',
        path: 'suggest',
        ownedBy: ['women'],
      } as CreateListingDto);

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: null, ownedBy: [] }),
      );
      expect(result.ownedBy).toEqual([]);
    });

    // `contactEmail` is retired. A stale cached frontend may still send it, so
    // the DTO accepts it, and the service must drop it on the floor.
    it('ignores a stale contactEmail: never stored and never returned', async () => {
      const result = await service.create('owner-1', {
        name: 'Lux Café',
        contactEmail: 'ana@example.com',
      } as CreateListingDto);

      const [savedListing] = listings.save.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(savedListing).not.toHaveProperty('contactEmail');
      expect(result).not.toHaveProperty('contactEmail');
    });

    it('retries the slug on a 23505 unique-violation race', async () => {
      listings.exists
        .mockResolvedValueOnce(true) // first candidate taken
        .mockResolvedValueOnce(false);

      const result = await service.create('owner-1', {
        name: 'Lux Café',
      } as CreateListingDto);
      expect(result.slug).toBeDefined();
      expect(listings.exists).toHaveBeenCalledTimes(2);
    });

    it('tells the listing-submission queue with the saved row id', async () => {
      await service.create('owner-1', { name: 'Lux Café' } as CreateListingDto);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ListingSubmissions,
        'listing-new',
      );
    });

    it('tells nobody when the listing is never saved', async () => {
      listings.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.create('owner-1', { name: 'Lux Café' } as CreateListingDto),
      ).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    describe('who holds the new listing', () => {
      /** What `listings.save` was handed, which is the row as it was written. */
      const savedRow = (): Record<string, unknown> => {
        const [firstCall] = listings.save.mock.calls as [
          Record<string, unknown>,
        ][];
        expect(firstCall).toBeDefined();
        return firstCall![0];
      };

      it('keeps a suggestion with the platform and records the suggester apart', async () => {
        await service.create('member-1', {
          name: 'Lux Café',
          path: 'suggest',
          ownerName: 'Ana',
          visibility: 'anon',
          linkToProfile: true,
        } as CreateListingDto);

        const row = savedRow();
        expect(row).toEqual(
          expect.objectContaining({
            ownerId: null,
            suggestedByUserId: 'member-1',
            affirmingBaselineAcceptedAt: null,
            ownerName: '',
            visibility: '',
            linkToProfile: false,
          }),
        );
      });

      it('makes the claimant the owner, with an acceptance and no suggester', async () => {
        await service.create('member-1', {
          name: 'Lux Café',
          path: 'claim',
          hours: {
            Mon: { open: true, intervals: [{ from: '09:00', to: '17:00' }] },
          },
          photoGallery: [
            { image: 'https://example.com/front.jpg', alt: 'The front door' },
          ],
        } as CreateListingDto);

        const row = savedRow();
        expect(row).toEqual(expect.objectContaining({ ownerId: 'member-1' }));
        // `normalizeCreate` omits the column and the claim path passes no
        // overrides, so the create call carries no such property at all.
        expect(row.suggestedByUserId).toBeUndefined();
        expect(row.affirmingBaselineAcceptedAt).toBeInstanceOf(Date);
      });
    });

    describe('owner outreach', () => {
      /** The reason codes of every report the create filed. */
      const filedReasonCodes = (): unknown[] =>
        (reports.create.mock.calls as [string, { reasonCode: string }][]).map(
          ([, reportBody]) => reportBody.reasonCode,
        );

      // `badge: 'friendly'` says the business is LGBTQ+ friendly as opposed
      // to queer-owned. On the claim path the submitter is its owner, so
      // nobody needs to reach out to the business.
      it('files no owner-outreach task for a claim-path create with the friendly badge', async () => {
        await service.create('member-1', {
          name: 'Lux Café',
          path: 'claim',
          badge: 'friendly',
          hours: {
            Mon: { open: true, intervals: [{ from: '09:00', to: '17:00' }] },
          },
          photoGallery: [
            { image: 'https://example.com/front.jpg', alt: 'The front door' },
          ],
        } as CreateListingDto);

        expect(listings.save).toHaveBeenCalled();
        expect(filedReasonCodes()).not.toContain('listing_owner_notify');
      });

      it('files an owner-outreach task for a suggestion', async () => {
        await service.create('member-1', {
          name: 'Lux Café',
          path: 'suggest',
        } as CreateListingDto);

        expect(reports.create).toHaveBeenCalledWith(
          'member-1',
          expect.objectContaining({
            reasonCode: 'listing_owner_notify',
            detail: expect.stringContaining(
              'Owner outreach: suggested listing',
            ) as unknown,
          }),
        );
      });
    });

    describe('curated tags', () => {
      it('stores vocabulary tags in their canonical spelling', async () => {
        await service.create('owner-1', {
          name: 'Lux Café',
          tags: ['  vegan options ', 'TERRACE', 'terrace'],
        } as CreateListingDto);

        expect(listings.save).toHaveBeenCalledWith(
          expect.objectContaining({ tags: ['Vegan options', 'Terrace'] }),
        );
      });

      it('400s a tag outside the vocabulary, before drawing a ref or saving', async () => {
        const attempt = service.create('owner-1', {
          name: 'Lux Café',
          tags: ['Terrace', 'Dog-friendly'],
        } as CreateListingDto);

        await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        await expect(attempt).rejects.toThrow(/"Dog-friendly"/);
        expect(dataSource.query).not.toHaveBeenCalled();
        expect(listings.save).not.toHaveBeenCalled();
      });
    });
  });

  describe('listings with no fixed premises', () => {
    const OWNER_ID = 'owner-1';
    const MEETING_POINT = {
      hood: 'Santa Maria Maior',
      address: 'Praça do Comércio',
      latitude: 38.7075,
      longitude: -9.1364,
    };
    const SCISSORS_PHOTO_URL = 'https://images.unsplash.com/photo-scissors.jpg';
    const ONLINE_AND_MOBILE =
      'A listing that is out and about (mobile) cannot also be online only.';

    const mobileBody = (overrides: Partial<CreateListingDto> = {}) =>
      ({
        name: 'Corte Móvel',
        cats: ['grooming'],
        mobile: true,
        mobileDetails: {
          allOfCity: false,
          parishes: ['Arroios', 'Penha de França', 'Estrela'],
        },
        ...overrides,
      }) as CreateListingDto;

    const storedMobileListing = (overrides: Partial<Listing> = {}) =>
      baseListing({
        ownerId: OWNER_ID,
        cats: ['tours'],
        mobile: true,
        hood: '',
        address: '',
        latitude: null,
        longitude: null,
        mobileDetails: emptyListingMobileDetails(),
        ...overrides,
      });

    const savedRow = () =>
      (listings.save.mock.calls.at(-1) as [Listing] | undefined)?.[0];

    describe('create', () => {
      it('stores a mobile listing with no meeting point and no location', async () => {
        const result = await service.create(
          OWNER_ID,
          mobileBody({
            hood: 'Arroios',
            address: 'Rua do Benformoso 12',
            latitude: 38.72,
            city: 'Lisboa',
          }),
        );

        expect(savedRow()).toEqual(
          expect.objectContaining({
            online: false,
            mobile: true,
            hood: '',
            address: '',
            geocoded: false,
            latitude: null,
            longitude: null,
            city: 'Lisbon',
          }),
        );
        expect(savedRow()?.mobileDetails).toEqual({
          allOfCity: false,
          parishes: ['Arroios', 'Estrela', 'Penha de França'],
          alsoTravelsTo: [],
          byAppointment: false,
        });
        expect(result.mobile).toBe(true);
        expect(result.mobileDetails.parishes).toHaveLength(3);
      });

      it('keeps a meeting point that has both coordinates', async () => {
        await service.create(
          OWNER_ID,
          mobileBody({
            cats: ['tours'],
            mobileDetails: { allOfCity: true },
            geocoded: true,
            ...MEETING_POINT,
          }),
        );

        expect(savedRow()).toEqual(
          expect.objectContaining({
            mobile: true,
            geocoded: true,
            ...MEETING_POINT,
          }),
        );
      });

      it('refuses online and mobile together before drawing a ref, ahead of any category rule', async () => {
        await expect(
          service.create(OWNER_ID, mobileBody({ online: true })),
        ).rejects.toThrow(ONLINE_AND_MOBILE);
        expect(dataSource.query).not.toHaveBeenCalled();
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('refuses "some parishes" with none picked', async () => {
        await expect(
          service.create(
            OWNER_ID,
            mobileBody({ mobileDetails: { allOfCity: false, parishes: [] } }),
          ),
        ).rejects.toThrow(
          'mobileDetails.parishes needs at least one parish when allOfCity is false.',
        );
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('refuses a parish outside the 24', async () => {
        await expect(
          service.create(
            OWNER_ID,
            mobileBody({
              mobileDetails: { allOfCity: false, parishes: ['Anjos'] },
            }),
          ),
        ).rejects.toThrow(
          'mobileDetails.parishes holds a name outside the 24 Lisbon parishes: "Anjos".',
        );
      });

      it('offers the place categories, the two new ones included, to a mobile listing', async () => {
        await expect(
          service.create(
            OWNER_ID,
            mobileBody({ cats: ['tours', 'home-services'] }),
          ),
        ).resolves.toBeDefined();
        await expect(
          service.create(OWNER_ID, mobileBody({ cats: ['apparel'] })),
        ).rejects.toThrow(
          'Category "apparel" is not offered to place listings',
        );
      });

      it('lets a mobile listing also sell online, as a place does', async () => {
        await service.create(
          OWNER_ID,
          mobileBody({
            hasOnlineShop: true,
            onlineDetails: {
              mainLink: { url: 'cortemovel.pt', kind: 'booking' },
            },
          }),
        );

        expect(savedRow()?.hasOnlineShop).toBe(true);
        expect(savedRow()?.onlineDetails.mainLink).toEqual({
          url: 'https://cortemovel.pt',
          kind: 'booking',
        });
      });

      it('gives a place the default details whatever the body sent', async () => {
        await service.create(OWNER_ID, {
          name: 'Casa',
          cats: ['food'],
          mobileDetails: { allOfCity: false, parishes: ['Arroios'] },
        } as CreateListingDto);

        expect(savedRow()?.mobile).toBe(false);
        expect(savedRow()?.mobileDetails).toEqual(emptyListingMobileDetails());
      });

      it('applies the mobile rules to a staff create', async () => {
        await service.adminCreate('admin-1', {
          name: 'Mudanças Arco-Íris',
          cats: ['home-services'],
          mobile: true,
          mobileDetails: {
            allOfCity: true,
            alsoTravelsTo: ['Oeiras', 'Almada'],
            byAppointment: true,
          },
          hood: 'Arroios',
          address: 'Rua X 1',
          publishState: 'review',
        } as AdminCreateListingDto);

        expect(savedRow()).toEqual(
          expect.objectContaining({
            mobile: true,
            hood: '',
            address: '',
            latitude: null,
            longitude: null,
          }),
        );
        expect(savedRow()?.mobileDetails).toEqual({
          allOfCity: true,
          parishes: [],
          alsoTravelsTo: ['Almada', 'Oeiras'],
          byAppointment: true,
        });
      });

      it('refuses online and mobile together on a staff create', async () => {
        await expect(
          service.adminCreate('admin-1', {
            name: 'Both',
            cats: ['tours'],
            online: true,
            mobile: true,
            publishState: 'review',
          } as AdminCreateListingDto),
        ).rejects.toThrow(ONLINE_AND_MOBILE);
        expect(listings.save).not.toHaveBeenCalled();
      });
    });

    describe('the claim path', () => {
      const claimedMobile = (overrides: Partial<CreateListingDto> = {}) =>
        mobileBody({
          path: 'claim',
          photoGallery: [
            { image: SCISSORS_PHOTO_URL, alt: 'Scissors on a towel' },
          ],
          ...overrides,
        });

      it('answers an online and mobile claim with the online+mobile rule, ahead of the claim-presence rule', async () => {
        await expect(
          service.create(OWNER_ID, claimedMobile({ online: true })),
        ).rejects.toThrow(ONLINE_AND_MOBILE);
      });

      it('asks a mobile listing for opening hours or "by appointment only"', async () => {
        await expect(service.create(OWNER_ID, claimedMobile())).rejects.toThrow(
          'Claiming a listing requires opening hours or "by appointment only".',
        );
      });

      it('takes "by appointment only" in place of opening hours', async () => {
        await expect(
          service.create(
            OWNER_ID,
            claimedMobile({
              mobileDetails: { allOfCity: true, byAppointment: true },
            }),
          ),
        ).resolves.toBeDefined();
      });

      it('takes one open day', async () => {
        await expect(
          service.create(
            OWNER_ID,
            claimedMobile({
              hours: {
                Mon: {
                  open: true,
                  intervals: [{ from: '09:00', to: '18:00' }],
                },
              },
            }),
          ),
        ).resolves.toBeDefined();
      });

      it('asks nothing of a suggested mobile listing', async () => {
        await expect(
          service.create('member-1', mobileBody({ path: 'suggest' })),
        ).resolves.toBeDefined();
      });
    });

    describe('edits', () => {
      it('blanks the location when a PATCH turns a place into a mobile listing with no coordinates', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            cats: ['grooming'],
            address: 'Rua do Benformoso 12',
            geocoded: true,
            latitude: 38.72,
            longitude: -9.135,
          }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          mobile: true,
          mobileDetails: { allOfCity: true },
          latitude: null as unknown as number,
          longitude: null as unknown as number,
        });

        expect(savedRow()).toEqual(
          expect.objectContaining({
            mobile: true,
            hood: '',
            address: '',
            geocoded: false,
            latitude: null,
            longitude: null,
          }),
        );
        expect(dto.mobile).toBe(true);
      });

      it('keeps the stored pin as the meeting point when a PATCH turning a place mobile sends no coordinates', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            cats: ['tours'],
            geocoded: true,
            ...MEETING_POINT,
          }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, { mobile: true });

        expect(savedRow()).toEqual(
          expect.objectContaining({ mobile: true, ...MEETING_POINT }),
        );
      });

      it('resets the details when a mobile listing becomes a place', async () => {
        listings.findOne.mockResolvedValue(
          storedMobileListing({
            mobileDetails: {
              allOfCity: false,
              parishes: ['Arroios'],
              alsoTravelsTo: [],
              byAppointment: true,
            },
          }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, {
          mobile: false,
          hood: 'Arroios',
          address: 'Rua X 1',
          latitude: 38.72,
          longitude: -9.135,
        });

        expect(savedRow()?.mobile).toBe(false);
        expect(savedRow()?.mobileDetails).toEqual(emptyListingMobileDetails());
        expect(savedRow()?.address).toBe('Rua X 1');
      });

      it('refuses a PATCH that makes a mobile listing online and leaves mobile set', async () => {
        listings.findOne.mockResolvedValue(storedMobileListing());

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            online: true,
            cats: ['classes'],
          }),
        ).rejects.toThrow(ONLINE_AND_MOBILE);
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('moves a mobile listing online when the same PATCH clears mobile', async () => {
        listings.findOne.mockResolvedValue(storedMobileListing());

        await service.update('QPL-2026-0001', OWNER_ID, {
          online: true,
          mobile: false,
          cats: ['classes'],
          onlineDetails: {
            mainLink: { url: 'lisboaape.pt', kind: 'booking' },
          },
        });

        expect(savedRow()).toEqual(
          expect.objectContaining({ online: true, mobile: false }),
        );
        expect(savedRow()?.mobileDetails).toEqual(emptyListingMobileDetails());
      });

      it.each([
        [
          'a place',
          baseListing({
            ownerId: OWNER_ID,
            status: ListingStatus.Live,
            blurb: 'Same blurb',
            mobile: false,
            mobileDetails: {} as Listing['mobileDetails'],
          }),
        ],
        [
          'a mobile listing',
          storedMobileListing({
            status: ListingStatus.Live,
            blurb: 'Same blurb',
            mobileDetails: {} as Listing['mobileDetails'],
          }),
        ],
      ])(
        'writes no audit row for an unrelated PATCH on %s from before the mobile fields',
        async (_label, storedRow) => {
          listings.findOne.mockResolvedValue(storedRow);

          const dto = await service.update('QPL-2026-0001', OWNER_ID, {
            blurb: 'Same blurb',
          });

          expect(dto.detailsConfirmedAt).toBeNull();
          expect(transactionManager.save).not.toHaveBeenCalled();
        },
      );

      it('names a change to where the business works in the owner_edited audit row', async () => {
        listings.findOne.mockResolvedValue(
          storedMobileListing({ status: ListingStatus.Live }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, {
          mobileDetails: { allOfCity: false, parishes: ['Belém'] },
        });

        expect(transactionManager.save).toHaveBeenCalledWith(
          ListingModerationEvent,
          expect.objectContaining({
            changedFields: ['mobileDetails'],
            reason: expect.stringContaining(
              'where the business works',
            ) as unknown,
          }),
        );
      });
    });

    describe('listManaged', () => {
      const runnableScope = {
        status: ListingStatus.Live,
        isHiddenByOwner: false,
        operatingState: Not(ListingOperatingState.PermanentlyClosed),
      };

      it('lists the runnable listings the member owns or co-manages, by name, with kind and meeting point', async () => {
        coManagers.listingIdsCoManagedBy.mockResolvedValue(['listing-co']);
        listings.find.mockResolvedValue([
          storedMobileListing({
            id: 'listing-co',
            ref: 'QPL-2026-0002',
            slug: 'lisboa-a-pe',
            name: 'Lisboa a Pé',
            ...MEETING_POINT,
          }),
          baseListing({
            id: 'listing-1',
            ref: 'QPL-2026-0001',
            slug: 'lux-cafe',
            name: 'Lux Café',
          }),
        ]);

        const items = await service.listManaged(OWNER_ID);

        expect(listings.find).toHaveBeenCalledWith({
          where: [
            { ...runnableScope, ownerId: OWNER_ID },
            { ...runnableScope, id: In(['listing-co']) },
          ],
          order: { name: 'ASC' },
          take: DEFAULT_LIST_LIMIT,
        });
        expect(items).toEqual([
          {
            id: 'listing-co',
            ref: 'QPL-2026-0002',
            slug: 'lisboa-a-pe',
            name: 'Lisboa a Pé',
            kind: 'mobile',
            meetingPoint: {
              address: 'Praça do Comércio',
              hood: 'Santa Maria Maior',
              latitude: 38.7075,
              longitude: -9.1364,
            },
          },
          {
            id: 'listing-1',
            ref: 'QPL-2026-0001',
            slug: 'lux-cafe',
            name: 'Lux Café',
            kind: 'place',
            meetingPoint: null,
          },
        ]);
      });

      it('asks for the owned listings alone when the member co-manages none', async () => {
        await service.listManaged(OWNER_ID);

        expect(listings.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: [{ ...runnableScope, ownerId: OWNER_ID }],
          }),
        );
      });
    });
  });

  describe('listMine', () => {
    it('scopes the query to the caller and paginates', async () => {
      await service.listMine('owner-1', { page: 2 });

      const qb = listings.createQueryBuilder.mock.results[0]!.value as {
        where: jest.Mock;
        skip: jest.Mock;
      };
      expect(qb.where).toHaveBeenCalledWith('l.owner_id = :userId', {
        userId: 'owner-1',
      });
      expect(qb.skip).toHaveBeenCalled();
    });
  });

  describe('getByRef', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.getByRef('QPL-2026-9999', 'owner-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a caller who does not own the listing', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );
      await expect(
        service.getByRef('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the listing to its owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      const dto = await service.getByRef('QPL-2026-0001', 'owner-1');
      expect(dto.ref).toBe('QPL-2026-0001');
      expect(dto.name).toBe('Lux Café');
    });
  });

  describe('update', () => {
    it('404s a non-owner and writes nothing', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );
      await expect(
        service.update('QPL-2026-0001', 'someone-else', { blurb: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('patches only the given fields for the owner', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', blurb: 'old' }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        blurb: 'new blurb',
      });

      expect(dto.blurb).toBe('new blurb');
      expect(dto.name).toBe('Lux Café'); // untouched field preserved
    });

    it('accepts a stale path in the patch and keeps the path the listing came in on', async () => {
      // An older cached frontend still sends `path`. It is fixed at creation,
      // so the PATCH succeeds and the stored value stays as it was.
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', path: 'suggest' }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        path: 'claim',
      });

      expect(dto.path).toBe('suggest');
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'suggest' }),
      );
    });

    it('merges partial social/photos patches instead of replacing the whole object', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: 'owner-1',
          social: {
            instagram: '@lux',
            website: '',
            email: 'a@b.com',
            phone: '',
          },
        }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        social: { phone: '+351123' },
      });

      expect(dto.social).toEqual({
        instagram: '@lux',
        website: '',
        email: 'a@b.com',
        phone: '+351123',
      });
    });

    // Regression test: `changedListingFields` used to compare jsonb columns
    // with a plain `JSON.stringify`, which is sensitive to key order. Postgres
    // reorders jsonb object keys on read (shorter keys first) independent of
    // how `applyUpdate`/`normalizeListingMenu` wrote them, so the "before"
    // listing's `menu` carried a different key order than the freshly
    // normalized "after" value even when nothing about the menu had changed:
    // every owner PATCH falsely stamped `detailsConfirmedAt` and wrote an
    // `owner_edited` audit row. This mimics that jsonb reordering directly in
    // the fixture (`{ file, link, sections }` instead of the normalizer's own
    // `{ sections, file, link }`) since the mocked repository does not round-
    // trip through Postgres.
    it('does not treat a same-content, differently-ordered menu as changed', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: 'owner-1',
          status: ListingStatus.Live,
          menu: { file: null, link: '', sections: [] },
        }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        menu: { sections: [], file: null, link: '' },
      });

      expect(dto.detailsConfirmedAt).toBeNull();
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(listings.save).toHaveBeenCalled();
    });

    // `contactEmail` is retired: a stale client may still PATCH it, and the
    // service leaves the stored value alone, so no `owner_edited` row or
    // freshness stamp can ever name it.
    it('ignores a stale contactEmail on a live listing and records no edit for it', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: 'owner-1',
          status: ListingStatus.Live,
          contactEmail: 'stored-before-retirement@example.com',
        }),
      );

      const dto = await service.update('QPL-2026-0001', 'owner-1', {
        contactEmail: 'ana@example.com',
      });

      const [savedListing] = listings.save.mock.calls[0] as [Listing];
      expect(savedListing.contactEmail).toBe(
        'stored-before-retirement@example.com',
      );
      expect(dto).not.toHaveProperty('contactEmail');
      expect(dto.detailsConfirmedAt).toBeNull();
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    // Finding M1: `ListingsController.update` keeps the interceptor's
    // foreign-upload exemption (a claimed listing has more than one editor),
    // so the service is the line that stops a member introducing a NEW photo
    // that is not theirs while still letting a co-editor re-save one a
    // different collaborator uploaded.
    describe('curated tags', () => {
      it('400s a tag outside the vocabulary and writes nothing', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', tags: ['Terrace'] }),
        );

        await expect(
          service.update('QPL-2026-0001', 'owner-1', {
            tags: ['Terrace', 'Dog-friendly'],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('keeps a legacy tag the listing already carries, in its stored spelling', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', tags: ['Walk-ins welcome'] }),
        );

        const result = await service.update('QPL-2026-0001', 'owner-1', {
          tags: ['walk-ins welcome', 'late opening'],
        });

        expect(result.tags).toEqual(['Walk-ins welcome', 'Late opening']);
      });

      it('rejects a legacy tag the listing does not already carry', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', tags: [] }),
        );

        await expect(
          service.update('QPL-2026-0001', 'owner-1', {
            tags: ['Walk-ins welcome'],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('leaves the tags alone when the patch does not mention them', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', tags: ['Walk-ins welcome'] }),
        );

        const result = await service.update('QPL-2026-0001', 'owner-1', {
          blurb: 'new blurb',
        });

        expect(result.tags).toEqual(['Walk-ins welcome']);
      });
    });

    describe('foreign photo ownership (M1)', () => {
      const OWNER_ID = 'owner-1';
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      // A well-formed key whose embedded owner segment is NOT the requester.
      const FOREIGN_KEY = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;

      it('allows re-saving a photo slot the listing already carries', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            photos: { wide: FOREIGN_KEY, d1: '', d2: '', vibe: '' },
          }),
        );
        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            photos: { wide: FOREIGN_KEY },
          }),
        ).resolves.toBeDefined();
      });

      it('rejects a new foreign photo the listing does not carry', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            photos: { wide: '', d1: '', d2: '', vibe: '' },
          }),
        );
        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            photos: { wide: FOREIGN_KEY },
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('allows re-sending a gallery photo the listing already carries', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            photoGallery: [
              {
                image: FOREIGN_KEY,
                alt: 'Uploaded by a co-editor',
                caption: '',
              },
            ],
          }),
        );
        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            photoGallery: [
              { image: FOREIGN_KEY, alt: 'Uploaded by a co-editor' },
            ],
          }),
        ).resolves.toBeDefined();
      });

      it('rejects a new foreign photo introduced through the gallery', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, photoGallery: [] }),
        );
        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            photoGallery: [{ image: FOREIGN_KEY, alt: 'Not mine' }],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(listings.save).not.toHaveBeenCalled();
      });
    });

    // The ordered gallery is the source of truth; the legacy `photos`/`alt`
    // slot pair is a derived mirror of its first four entries.
    describe('ordered photo gallery', () => {
      // Absolute `https://` values, because `toImageUrl` resolves a stored
      // image to a URL and drops anything that is neither one of our storage
      // keys nor an absolute https URL. A bare `photo-0.jpg` would come back
      // as `null` on the response and the assertions below would be reading
      // the mapper's rejection rather than the gallery.
      const imageUrlOf = (name: string) => `https://images.test/${name}.jpg`;
      const galleryOf = (count: number) =>
        Array.from({ length: count }, (_unused, index) => ({
          image: imageUrlOf(`photo-${index}`),
          alt: `Photo ${index}`,
          caption: index === 4 ? 'Open studio night' : '',
        }));

      it('replaces the gallery wholesale and rewrites the legacy mirror', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', photoGallery: galleryOf(3) }),
        );

        const dto = await service.update('QPL-2026-0001', 'owner-1', {
          photoGallery: [{ image: imageUrlOf('only'), alt: 'The only photo' }],
        });

        expect(dto.photoGallery).toHaveLength(1);
        expect(dto.photoGallery[0]?.alt).toBe('The only photo');
        // The mirror follows the gallery rather than merging with what was
        // there before, so a removed photo is really removed.
        expect(dto.photos.d1).toBeNull();
        expect(dto.photos.d2).toBeNull();
      });

      it('applies a legacy slot patch without deleting a fifth photo or a caption', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', photoGallery: galleryOf(5) }),
        );

        const dto = await service.update('QPL-2026-0001', 'owner-1', {
          photos: { d1: imageUrlOf('replaced') },
        });

        expect(dto.photoGallery).toHaveLength(5);
        expect(dto.photoGallery[1]?.image).toContain('replaced.jpg');
        expect(dto.photoGallery[4]?.caption).toBe('Open studio night');
      });
    });
  });

  describe('online listings', () => {
    const OWNER_ID = 'owner-1';
    const OTHER_ID = '22222222-2222-2222-2222-222222222222';
    const FILE_SEGMENT = '44444444-4444-4444-4444-444444444444';
    const FOREIGN_KEY = `listing-photos/${OTHER_ID}/${FILE_SEGMENT}.jpg`;
    const MUG_PHOTO_URL = 'https://images.unsplash.com/photo-mug.jpg';
    const STORED_STAMP = '2026-10-01T09:00:00.000Z';
    const FORGED_STAMP = '2020-01-01T00:00:00.000Z';

    const onlineBody = (overrides: Partial<CreateListingDto> = {}) =>
      ({
        name: 'Fio Rosa',
        online: true,
        cats: ['handmade'],
        onlineDetails: { mainLink: { url: 'fiorosa.pt', kind: 'shop' } },
        ...overrides,
      }) as CreateListingDto;

    const sellingDetails = () => ({
      ...emptyListingOnlineDetails(),
      mainLink: { url: 'https://fiorosa.pt', kind: 'shop' as const },
    });

    const storedOnlineListing = (overrides: Partial<Listing> = {}) =>
      baseListing({
        ownerId: OWNER_ID,
        online: true,
        cats: ['handmade'],
        hood: '',
        address: '',
        onlineDetails: sellingDetails(),
        ...overrides,
      });

    const savedRow = () =>
      (listings.save.mock.calls.at(-1) as [Listing] | undefined)?.[0];

    it('stores an online listing with no location, its own city, and no online shop flag', async () => {
      const result = await service.create(
        OWNER_ID,
        onlineBody({
          hasOnlineShop: true,
          city: ' Porto ',
          hood: 'Anjos',
          address: 'Rua X 1',
          latitude: 38.7,
          longitude: -9.1,
        }),
      );

      expect(savedRow()).toEqual(
        expect.objectContaining({
          online: true,
          hasOnlineShop: false,
          hood: '',
          address: '',
          latitude: null,
          longitude: null,
          city: 'Porto',
          pricingMode: 'services',
        }),
      );
      expect(savedRow()?.onlineDetails.mainLink).toEqual({
        url: 'https://fiorosa.pt',
        kind: 'shop',
      });
      expect(result.city).toBe('Porto');
    });

    it('refuses a place category on an online listing before drawing a ref', async () => {
      await expect(
        service.create(OWNER_ID, onlineBody({ cats: ['nightlife'] })),
      ).rejects.toThrow(
        'Category "nightlife" is not offered to online listings',
      );
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('refuses an online category on a place', async () => {
      await expect(
        service.create(OWNER_ID, {
          name: 'Casa',
          cats: ['apparel'],
        } as CreateListingDto),
      ).rejects.toThrow('Category "apparel" is not offered to place listings');
    });

    it('requires a main link from a listing that sells online', async () => {
      await expect(
        service.create(OWNER_ID, onlineBody({ onlineDetails: {} })),
      ).rejects.toThrow('onlineDetails.mainLink is required');
      await expect(
        service.create(OWNER_ID, {
          name: 'Casa',
          cats: ['food'],
          hasOnlineShop: true,
        } as CreateListingDto),
      ).rejects.toThrow('onlineDetails.mainLink is required');
    });

    it('empties the online fields of a place that does not sell online', async () => {
      await service.create(OWNER_ID, {
        name: 'Casa',
        cats: ['food'],
        pricingMode: 'shop',
        onlineDetails: {
          replyNote: 'Stale',
          mainLink: { url: 'casa.pt', kind: 'shop' },
        },
        shopItems: [{ id: 'item-1', name: 'Mug' }],
      } as CreateListingDto);

      expect(savedRow()?.onlineDetails).toEqual(emptyListingOnlineDetails());
      expect(savedRow()?.shopItems).toEqual([]);
      expect(savedRow()?.pricingMode).toBe('menu');
    });

    it('leaves pick-up out for a place that also sells online', async () => {
      await service.create(OWNER_ID, {
        name: 'Casa',
        cats: ['food'],
        hasOnlineShop: true,
        onlineDetails: {
          mainLink: { url: 'casa.pt', kind: 'shop' },
          fulfilment: ['pickupLisbon', 'shipsEu'],
          pickupNote: 'At the counter',
        },
      } as CreateListingDto);

      expect(savedRow()?.onlineDetails.fulfilment).toEqual(['shipsEu']);
      expect(savedRow()?.onlineDetails.pickupNote).toBe('');
      expect(savedRow()?.hasOnlineShop).toBe(true);
    });

    describe('the claim path', () => {
      const claimedOnline = (
        onlineDetails: CreateListingDto['onlineDetails'],
      ) =>
        onlineBody({
          path: 'claim',
          onlineDetails,
          photoGallery: [{ image: MUG_PHOTO_URL, alt: 'Yarn on a table' }],
        });

      it('asks an online listing for a delivery option or a session format', async () => {
        await expect(
          service.create(
            OWNER_ID,
            claimedOnline({ mainLink: { url: 'fiorosa.pt', kind: 'shop' } }),
          ),
        ).rejects.toThrow(
          'Claiming a listing requires a way people get it (a delivery option or a session format).',
        );
      });

      it('accepts a session format alone, and asks for no opening hours', async () => {
        await expect(
          service.create(
            OWNER_ID,
            claimedOnline({
              mainLink: { url: 'fiorosa.pt', kind: 'booking' },
              sessionFormats: ['video'],
            }),
          ),
        ).resolves.toBeDefined();
      });

      it('asks nothing of a suggested online listing', async () => {
        await expect(
          service.create(
            'member-1',
            onlineBody({
              path: 'suggest',
              onlineDetails: { mainLink: { url: 'fiorosa.pt', kind: 'shop' } },
            }),
          ),
        ).resolves.toBeDefined();
      });
    });

    describe('the 18+ terms', () => {
      it('refuses the 18+ category with no acceptance', async () => {
        const failure: unknown = await service
          .create(OWNER_ID, onlineBody({ cats: ['intimacy'] }))
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BadRequestException);
        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('stamps the first acceptance from the server clock', async () => {
        await service.create(
          OWNER_ID,
          onlineBody({ cats: ['intimacy'], adultTermsAccepted: true }),
        );

        const stamp = savedRow()?.onlineDetails.adultTermsAcceptedAt;
        expect(stamp).toEqual(expect.any(String));
        expect(Date.now() - Date.parse(stamp as string)).toBeLessThan(60_000);
      });

      it('refuses a suggestion in the 18+ category even when the suggester accepts', async () => {
        const failure: unknown = await service
          .create(
            'member-1',
            onlineBody({
              path: 'suggest',
              cats: ['intimacy'],
              adultTermsAccepted: true,
            }),
          )
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BadRequestException);
        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(dataSource.query).not.toHaveBeenCalled();
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('stamps a claim in the 18+ category when the claimant accepts', async () => {
        await service.create(
          OWNER_ID,
          onlineBody({
            path: 'claim',
            cats: ['intimacy'],
            adultTermsAccepted: true,
            onlineDetails: {
              mainLink: { url: 'fiorosa.pt', kind: 'shop' },
              fulfilment: ['shipsPortugal'],
            },
            photoGallery: [{ image: MUG_PHOTO_URL, alt: 'Yarn on a table' }],
          }),
        );

        expect(savedRow()?.ownerId).toBe(OWNER_ID);
        expect(savedRow()?.onlineDetails.adultTermsAcceptedAt).toEqual(
          expect.any(String),
        );
      });

      it('stores no acceptance stamp a create body carries', async () => {
        await service.create(
          OWNER_ID,
          onlineBody({
            onlineDetails: {
              mainLink: { url: 'fiorosa.pt', kind: 'shop' },
              adultTermsAcceptedAt: FORGED_STAMP,
            },
          }),
        );

        expect(savedRow()?.onlineDetails.adultTermsAcceptedAt).toBeNull();
      });

      it('replaces a forged stamp in a create body with the server clock', async () => {
        await service.create(
          OWNER_ID,
          onlineBody({
            cats: ['intimacy'],
            adultTermsAccepted: true,
            onlineDetails: {
              mainLink: { url: 'fiorosa.pt', kind: 'shop' },
              adultTermsAcceptedAt: FORGED_STAMP,
            },
          }),
        );

        const stamp = savedRow()?.onlineDetails.adultTermsAcceptedAt;
        expect(stamp).toEqual(expect.any(String));
        expect(stamp).not.toBe(FORGED_STAMP);
      });

      it('lets a later edit through with no second acceptance, stamp unchanged', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            cats: ['intimacy'],
            onlineDetails: {
              ...sellingDetails(),
              adultTermsAcceptedAt: STORED_STAMP,
            },
          }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          blurb: 'New blurb',
          onlineDetails: { mainLink: { url: 'fiorosa.pt', kind: 'shop' } },
        });

        expect(dto.onlineDetails.adultTermsAcceptedAt).toBe(STORED_STAMP);
      });

      it('keeps the stored stamp when an update carries a forged one', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            cats: ['intimacy'],
            onlineDetails: {
              ...sellingDetails(),
              adultTermsAcceptedAt: STORED_STAMP,
            },
          }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, {
          onlineDetails: {
            mainLink: { url: 'fiorosa.pt', kind: 'shop' },
            adultTermsAcceptedAt: FORGED_STAMP,
          },
        });

        expect(savedRow()?.onlineDetails.adultTermsAcceptedAt).toBe(
          STORED_STAMP,
        );
      });

      it('ignores an acceptance stamp a client sends', async () => {
        listings.findOne.mockResolvedValue(storedOnlineListing());

        const failure: unknown = await service
          .update('QPL-2026-0001', OWNER_ID, {
            cats: ['intimacy'],
            onlineDetails: {
              mainLink: { url: 'fiorosa.pt', kind: 'shop' },
              adultTermsAcceptedAt: FORGED_STAMP,
            },
          })
          .catch((error: unknown) => error);

        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('stamps an owner who accepts on an edit that adds the 18+ category', async () => {
        listings.findOne.mockResolvedValue(storedOnlineListing());

        await service.update('QPL-2026-0001', OWNER_ID, {
          cats: ['intimacy'],
          adultTermsAccepted: true,
        });

        expect(savedRow()?.cats).toEqual(['intimacy']);
        expect(savedRow()?.onlineDetails.adultTermsAcceptedAt).toEqual(
          expect.any(String),
        );
      });
    });

    describe('edits', () => {
      it('writes no audit row for an unrelated PATCH on a row from before the online fields', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            status: ListingStatus.Live,
            blurb: 'Same blurb',
            onlineDetails: {} as Listing['onlineDetails'],
            shopItems: undefined as unknown as Listing['shopItems'],
          }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          blurb: 'Same blurb',
        });

        expect(dto.detailsConfirmedAt).toBeNull();
        expect(transactionManager.save).not.toHaveBeenCalled();
      });

      it('writes no audit row for an unrelated PATCH on an online row that kept a neighbourhood', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            status: ListingStatus.Live,
            blurb: 'Same blurb',
            hood: 'Anjos',
          }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          blurb: 'Same blurb',
        });

        expect(dto.detailsConfirmedAt).toBeNull();
        expect(transactionManager.save).not.toHaveBeenCalled();
        expect(savedRow()?.hood).toBe('');
      });

      it('lets an online listing with no main link save an unrelated edit', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ onlineDetails: emptyListingOnlineDetails() }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          blurb: 'New blurb',
        });

        expect(dto.blurb).toBe('New blurb');
        expect(dto.onlineDetails.mainLink).toBeNull();
      });

      it('lets an online listing with no main link save its shop items', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ onlineDetails: emptyListingOnlineDetails() }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, {
          shopItems: [{ id: 'item-1', name: 'Zine' }],
        });

        expect(savedRow()?.shopItems).toEqual([
          { id: 'item-1', name: 'Zine', price: '', link: '', photo: null },
        ]);
      });

      it('asks for a main link once the PATCH touches the ordering section', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ onlineDetails: emptyListingOnlineDetails() }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            onlineDetails: { fulfilment: ['shipsEu'] },
          }),
        ).rejects.toThrow('onlineDetails.mainLink is required');
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('asks for a main link when a place turns on its online shop', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, cats: ['food'] }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, { hasOnlineShop: true }),
        ).rejects.toThrow('onlineDetails.mainLink is required');
      });

      it('lets a legacy category through on an edit that leaves categories alone', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, cats: ['café'] }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, { blurb: 'New blurb' }),
        ).resolves.toBeDefined();
      });

      it('checks the categories when the PATCH carries them', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, cats: ['food'] }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, { cats: ['apparel'] }),
        ).rejects.toThrow(
          'Category "apparel" is not offered to place listings',
        );
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('checks the stored categories when the PATCH turns a place online-only', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, cats: ['nightlife'] }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            online: true,
            onlineDetails: { mainLink: { url: 'casa.pt', kind: 'shop' } },
          }),
        ).rejects.toThrow(
          'Category "nightlife" is not offered to online listings',
        );
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('blanks the location when a place turns online-only, and keeps its new city', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: OWNER_ID,
            cats: ['food'],
            address: 'Rua X 1',
            latitude: 38.7,
            longitude: -9.1,
            geocoded: true,
          }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          online: true,
          city: 'Braga',
          onlineDetails: { mainLink: { url: 'casa.pt', kind: 'shop' } },
        });

        expect(savedRow()).toEqual(
          expect.objectContaining({
            hood: '',
            address: '',
            latitude: null,
            longitude: null,
            geocoded: false,
            city: 'Braga',
          }),
        );
        expect(dto.city).toBe('Braga');
      });

      it('gives an online listing turning into a place the one city when the PATCH names none', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ city: 'Porto' }),
        );

        const dto = await service.update('QPL-2026-0001', OWNER_ID, {
          online: false,
          cats: ['design'],
        });

        expect(savedRow()).toEqual(
          expect.objectContaining({ online: false, city: 'Lisbon' }),
        );
        expect(dto.city).toBe('Lisbon');
      });

      it('leaves the stored city of a place alone on an edit that names none', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: OWNER_ID, cats: ['food'], city: '' }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, { blurb: 'New blurb' });

        expect(savedRow()?.city).toBe('');
      });

      it('names a shop item change in the owner_edited audit row', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ status: ListingStatus.Live }),
        );

        await service.update('QPL-2026-0001', OWNER_ID, {
          shopItems: [{ id: 'item-1', name: 'Zine', price: '6 EUR' }],
        });

        expect(transactionManager.save).toHaveBeenCalledWith(
          ListingModerationEvent,
          expect.objectContaining({
            changedFields: ['shopItems'],
            reason: expect.stringContaining('the shop items') as unknown,
          }),
        );
      });
    });

    // Staff bodies omit `adultTermsAccepted`, so a staff write can never
    // accept the 18+ terms for a business. The service passes false on the
    // staff paths whatever the body holds, which the cast bodies below pin.
    describe('staff writes and the 18+ category', () => {
      it('refuses a staff create in the 18+ category', async () => {
        const failure: unknown = await service
          .adminCreate('admin-1', {
            name: 'Velvet Box',
            online: true,
            cats: ['intimacy'],
            onlineDetails: {
              mainLink: { url: 'velvet.example.pt', kind: 'shop' },
            },
            publishState: 'review',
          } as AdminCreateListingDto)
          .catch((error: unknown) => error);

        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('refuses a staff create in the 18+ category even with the flag smuggled in', async () => {
        const failure: unknown = await service
          .adminCreate('admin-1', {
            name: 'Velvet Box',
            online: true,
            cats: ['intimacy'],
            onlineDetails: {
              mainLink: { url: 'velvet.example.pt', kind: 'shop' },
            },
            publishState: 'review',
            adultTermsAccepted: true,
          } as unknown as AdminCreateListingDto)
          .catch((error: unknown) => error);

        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('keeps the 18+ category on a staff edit of a listing whose owner accepted', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            ownerId: null,
            cats: ['intimacy'],
            onlineDetails: {
              ...sellingDetails(),
              adultTermsAcceptedAt: STORED_STAMP,
            },
          }),
        );

        const dto = await service.adminUpdate('QPL-2026-0001', 'admin-1', {
          blurb: 'Staff correction',
        });

        expect(dto.onlineDetails.adultTermsAcceptedAt).toBe(STORED_STAMP);
      });

      it('refuses a staff edit that adds the 18+ category to an unaccepted listing', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ ownerId: null }),
        );

        const failure: unknown = await service
          .adminUpdate('QPL-2026-0001', 'admin-1', { cats: ['intimacy'] })
          .catch((error: unknown) => error);

        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(transactionManager.save).not.toHaveBeenCalled();
      });

      it('refuses a staff edit that adds the 18+ category even with the flag smuggled in', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({ ownerId: null }),
        );

        const failure: unknown = await service
          .adminUpdate('QPL-2026-0001', 'admin-1', {
            cats: ['intimacy'],
            adultTermsAccepted: true,
          } as unknown as AdminUpdateListingDto)
          .catch((error: unknown) => error);

        expect((failure as BadRequestException).getResponse()).toMatchObject({
          code: 'adult_terms_required',
        });
        expect(transactionManager.save).not.toHaveBeenCalled();
      });
    });

    describe('shop item photos', () => {
      it('refuses a new foreign upload introduced through a shop item', async () => {
        listings.findOne.mockResolvedValue(storedOnlineListing());

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            shopItems: [
              {
                id: 'item-1',
                name: 'Mug',
                photo: { image: FOREIGN_KEY, alt: 'Not mine' },
              },
            ],
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(listings.save).not.toHaveBeenCalled();
      });

      it('lets an edit re-save a shop item photo someone else uploaded once it is stored', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            shopItems: [
              {
                id: 'item-1',
                name: 'Mug',
                price: '',
                link: '',
                photo: { image: FOREIGN_KEY, alt: 'A mug', caption: '' },
              },
            ],
          }),
        );

        await expect(
          service.update('QPL-2026-0001', OWNER_ID, {
            shopItems: [
              {
                id: 'item-1',
                name: 'Blue mug',
                photo: { image: FOREIGN_KEY, alt: 'A mug' },
              },
            ],
          }),
        ).resolves.toBeDefined();
      });

      it('keeps a photo moved from the gallery into a shop item', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            photoGallery: [
              { image: MUG_PHOTO_URL, alt: 'A blue mug', caption: '' },
            ],
          }),
        );
        const storage = (
          service as unknown as {
            storage: { deleteObjectByReference: jest.Mock };
          }
        ).storage;

        await service.update('QPL-2026-0001', OWNER_ID, {
          photoGallery: [],
          shopItems: [
            {
              id: 'item-1',
              name: 'Mug',
              photo: { image: MUG_PHOTO_URL, alt: 'A blue mug' },
            },
          ],
        });

        expect(storage.deleteObjectByReference).not.toHaveBeenCalledWith(
          MUG_PHOTO_URL,
        );
      });

      it('cleans up a shop item photo the edit removes', async () => {
        listings.findOne.mockResolvedValue(
          storedOnlineListing({
            shopItems: [
              {
                id: 'item-1',
                name: 'Mug',
                price: '',
                link: '',
                photo: { image: MUG_PHOTO_URL, alt: 'A mug', caption: '' },
              },
            ],
          }),
        );
        const storage = (
          service as unknown as {
            storage: { deleteObjectByReference: jest.Mock };
          }
        ).storage;

        await service.update('QPL-2026-0001', OWNER_ID, { shopItems: [] });

        expect(storage.deleteObjectByReference).toHaveBeenCalledWith(
          MUG_PHOTO_URL,
        );
      });
    });
  });

  describe('remove', () => {
    it('404s a non-owner and does not delete', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );
      await expect(
        service.remove('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(listings.remove).not.toHaveBeenCalled();
    });

    it('removes the listing for its owner', async () => {
      const listing = baseListing({ ownerId: 'owner-1' });
      listings.findOne.mockResolvedValue(listing);

      await service.remove('QPL-2026-0001', 'owner-1');
      expect(listings.remove).toHaveBeenCalledWith(listing);
    });
  });

  describe('setStatus', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.setStatus('QPL-2026-9999', ListingStatus.Live, 'mod-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('transitions review -> live, records a status_changed event, and creates the ListingApproved notification (not a DM)', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          ownerId: 'owner-1',
          slug: 'lux-cafe',
        }),
      );
      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Live,
        'mod-1',
      );
      expect(dto.status).toBe(ListingStatus.Live);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.ListingApproved,
        expect.objectContaining({ listingSlug: 'lux-cafe' }),
      );
      // No "send back" DM on an approval into Live — the persisted
      // ListingApproved notification above covers it.
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('transitions review -> question, records the event, and best-effort DMs the submitter with the reason', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          ownerId: 'owner-1',
          name: 'Lux Café',
        }),
      );
      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Question,
        'mod-1',
        'need opening hours',
      );
      expect(dto.status).toBe(ListingStatus.Question);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Question,
          reason: 'need opening hours',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        expect.stringContaining('need opening hours'),
      );
      // Not an approval — no persisted notification.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('tells the suggester with a bell notification when a suggestion the platform holds goes live', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      );

      await service.setStatus('QPL-2026-0001', ListingStatus.Live, 'mod-1');

      // PRD-433. No actor: the bell never names the moderator. The slug opens
      // the public directory page.
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionLive,
        { source: 'listing', listingSlug: 'lux-cafe', listingName: 'Lux Café' },
      );
      // The `ListingApproved` notification says "your listing", which a
      // suggester does not hold, and the moderator no longer DMs them.
      expect(notifications.create).not.toHaveBeenCalledWith(
        expect.anything(),
        NotificationType.ListingApproved,
        expect.anything(),
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('keeps the moderator change when the suggester notification fails to write', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
        }),
      );
      notifications.create.mockRejectedValue(new Error('db down'));

      const dto = await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Live,
        'mod-1',
      );

      expect(dto.status).toBe(ListingStatus.Live);
    });

    it('notifies the suggester that their suggestion needs more information', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      );

      await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Question,
        'mod-1',
        'need opening hours',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionNeedsInfo,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
          reason: 'need opening hours',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('notifies the suggester that their suggestion was sent back to review', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Live,
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      );

      await service.setStatus('QPL-2026-0001', ListingStatus.Review, 'mod-1');

      // No reason given, so the payload carries none.
      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionSentBack,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('keeps the owner wording for an owned listing sent to question', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Review,
          ownerId: 'owner-1',
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      );

      await service.setStatus(
        'QPL-2026-0001',
        ListingStatus.Question,
        'mod-1',
        'need opening hours',
      );

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        'Your listing "Lux Café" needs more information before it can go live. Reason: need opening hours',
      );
    });

    it('keeps the owner wording for an owned listing sent back to review', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          status: ListingStatus.Live,
          ownerId: 'owner-1',
          name: 'Lux Café',
        }),
      );

      await service.setStatus('QPL-2026-0001', ListingStatus.Review, 'mod-1');

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        'Your listing "Lux Café" was sent back to review.',
      );
    });
  });

  describe('removeByModerator', () => {
    it('notifies the suggester that their suggestion was removed', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      );

      await service.removeByModerator(
        'QPL-2026-0001',
        'mod-1',
        'policy violation',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionRemoved,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
          reason: 'policy violation',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('keeps the owner wording when the listing has an owner', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', name: 'Lux Café' }),
      );

      await service.removeByModerator('QPL-2026-0001', 'mod-1');

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        'Your listing "Lux Café" was removed from QueerPulse.',
      );
    });
  });

  describe('askQuestion', () => {
    it('asks the suggester with a needs-info notification carrying the question, and no DM', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-id',
          status: ListingStatus.Review,
          name: 'Lux Café',
        }),
      );

      const dto = await service.askQuestion(
        'QPL-2026-0001',
        'mod-1',
        'Which street is it on?',
      );

      // PRD-433. The question is the notification's reason; no moderator is
      // named and the moderator's personal account sends nothing.
      expect(dto.status).toBe(ListingStatus.Question);
      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-id',
        NotificationType.ListingSuggestionNeedsInfo,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
          reason: 'Which street is it on?',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
      // The Q&A thread row and the audit event are kept.
      expect(questions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 'listing-1',
          askedBy: 'mod-1',
          body: 'Which street is it on?',
        }),
      );
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ListingModerationAction.QuestionAsked,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Question,
        }),
      );
    });

    it('reverts the status and throws when the suggester notification fails to write', async () => {
      const listing = baseListing({
        path: 'suggest',
        ownerId: null,
        suggestedByUserId: 'suggester-id',
        status: ListingStatus.Review,
      });
      listings.findOne.mockResolvedValue(listing);
      notifications.create.mockRejectedValue(new Error('bell is down'));

      await expect(
        service.askQuestion('QPL-2026-0001', 'mod-1', 'Which street is it on?'),
      ).rejects.toThrow('bell is down');

      // Saved once into Question, then once more back to Review.
      expect(listings.save).toHaveBeenCalledTimes(2);
      expect(listings.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ListingStatus.Review }),
      );
      expect(questions.save).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('keeps the DM for an owner and writes no notification', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: 'owner-1', status: ListingStatus.Review }),
      );

      await service.askQuestion(
        'QPL-2026-0001',
        'mod-1',
        'Which street is it on?',
      );

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        'Which street is it on?',
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('400s a house-authored listing with nobody to ask', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: null, suggestedByUserId: null }),
      );

      await expect(
        service.askQuestion('QPL-2026-0001', 'mod-1', 'Which street is it on?'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
      expect(listings.save).not.toHaveBeenCalled();
    });
  });

  describe('replyToReview', () => {
    const baseReview = {
      id: 'review-1',
      listingId: 'listing-1',
      reviewerId: 'member-1',
      reviewerName: 'Alex',
      byline: 'they/them',
      stars: 5,
      text: 'Loved it',
      helpful: 0,
      ownerReplyText: null,
      ownerRepliedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('404s an unknown listing ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.replyToReview('QPL-2026-9999', 'owner-1', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('404s a caller who does not own the listing', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );
      await expect(
        service.replyToReview('QPL-2026-0001', 'someone-else', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.findOne).not.toHaveBeenCalled();
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('404s a review that does not belong to this listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue(null);

      await expect(
        service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks!',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviews.findOne).toHaveBeenCalledWith({
        where: { id: 'review-1', listingId: 'listing-1' },
      });
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('400s a whitespace-only reply without saving', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({ ...baseReview });

      await expect(
        service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reviews.save).not.toHaveBeenCalled();
    });

    it('sets a trimmed reply + timestamp for the owner', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({ ...baseReview });

      const dto = await service.replyToReview(
        'QPL-2026-0001',
        'owner-1',
        'review-1',
        { text: '  Thanks for the kind words!  ' },
      );

      expect(reviews.save).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerReplyText: 'Thanks for the kind words!',
          ownerRepliedAt: expect.any(Date) as unknown,
        }),
      );
      expect(dto.ownerReply).toEqual({
        text: 'Thanks for the kind words!',
        at: expect.any(String) as unknown,
      });
    });

    it('overwrites an existing reply', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      reviews.findOne.mockResolvedValue({
        ...baseReview,
        ownerReplyText: 'Old reply',
        ownerRepliedAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      const dto = await service.replyToReview(
        'QPL-2026-0001',
        'owner-1',
        'review-1',
        { text: 'New reply' },
      );

      expect(dto.ownerReply?.text).toBe('New reply');
    });

    // PRD-47. The directory was the precedent the employer and housing review
    // replies were built from, and it was the one that answered the reviewer
    // in silence.
    describe('telling the review author about it', () => {
      it('tells the author, deep-linking the business page the reply is on', async () => {
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        reviews.findOne.mockResolvedValue({ ...baseReview });

        await service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks for the kind words!',
        });

        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledTimes(1);
        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledWith({
          reviewAuthorId: 'member-1',
          // `linkToProfile` is false on the fixture, so the page does not name
          // the owner and neither does the bell.
          replyingSubjectId: null,
          // The gate actor is the real replier even so, which is the whole
          // point of the second field: withholding the name must not withhold
          // the block/mute gate.
          blockGateActorId: 'owner-1',
          subjectLabel: 'Lux Café',
          deepLinkSource: 'listing',
          deepLinkSlug: 'lux-cafe',
        });
      });

      it('names the owner only where the public page already links them', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'public',
            linkToProfile: true,
          }),
        );
        reviews.findOne.mockResolvedValue({ ...baseReview });

        await service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks!',
        });

        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledWith(
          expect.objectContaining({ replyingSubjectId: 'owner-1' }),
        );
      });

      it('never names an owner who chose to stay anonymous', async () => {
        // `visibility: 'anon'` is a safety decision about being publicly known
        // as a queer business owner. An actor on this row would put their name,
        // face and profile link in the reviewer's bell and undo it.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'anon',
            linkToProfile: true,
          }),
        );
        reviews.findOne.mockResolvedValue({ ...baseReview });

        await service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks!',
        });

        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledWith(
          expect.objectContaining({ replyingSubjectId: null }),
        );
      });

      it('still gates an anonymous owner on block and mute, having withheld their name', async () => {
        // The regression this exists for: `replyingSubjectId` used to be both
        // the name and the block/mute gate, so hiding the name here silently
        // handed the row to a reviewer who had blocked this owner.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'anon',
            linkToProfile: true,
          }),
        );
        reviews.findOne.mockResolvedValue({ ...baseReview });

        await service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'Thanks!',
        });

        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledWith(
          expect.objectContaining({
            replyingSubjectId: null,
            blockGateActorId: 'owner-1',
          }),
        );
      });

      it('never names a co-manager, who is invisible on the public page', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'public',
            linkToProfile: true,
          }),
        );
        coManagers.isActiveCoManager.mockResolvedValue(true);
        reviews.findOne.mockResolvedValue({ ...baseReview });

        await service.replyToReview(
          'QPL-2026-0001',
          'co-manager-1',
          'review-1',
          { text: 'Thanks!' },
        );

        expect(reviewReplies.notifyReviewReplied).toHaveBeenCalledWith(
          expect.objectContaining({
            replyingSubjectId: null,
            // A blocked co-manager stays unreachable too, on the same field.
            blockGateActorId: 'co-manager-1',
          }),
        );
      });

      it('stays silent when the owner edits a reply they already published', async () => {
        // The harassment vector: one listing carries ONE reply and this method
        // overwrites it, so notifying per save would let an owner ring the
        // reviewer's bell as often as they cared to retype it.
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        reviews.findOne.mockResolvedValue({
          ...baseReview,
          ownerReplyText: 'Old reply',
          ownerRepliedAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        await service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
          text: 'New reply',
        });

        expect(reviewReplies.notifyReviewReplied).not.toHaveBeenCalled();
        // The edit itself still lands.
        expect(reviews.save).toHaveBeenCalledWith(
          expect.objectContaining({ ownerReplyText: 'New reply' }),
        );
      });

      it('writes nothing when the review author has erased their account', async () => {
        // `listing_reviews.reviewer_id` is ON DELETE SET NULL: the review
        // survives for other readers with nobody left to tell.
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        reviews.findOne.mockResolvedValue({
          ...baseReview,
          reviewerId: null,
        });

        const dto = await service.replyToReview(
          'QPL-2026-0001',
          'owner-1',
          'review-1',
          { text: 'Thanks!' },
        );

        expect(reviewReplies.notifyReviewReplied).not.toHaveBeenCalled();
        expect(dto.ownerReply?.text).toBe('Thanks!');
      });

      it('does not notify a co-manager who replied to their own review', async () => {
        // Reachable: `DirectoryService.addReview` blocks only the OWNER from
        // reviewing, so a co-manager can review the listing they help run. The
        // notifier guards it too, off `blockGateActorId`, but this service is
        // where a reader learns the case exists, so it is caught here as well.
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        coManagers.isActiveCoManager.mockResolvedValue(true);
        reviews.findOne.mockResolvedValue({
          ...baseReview,
          reviewerId: 'co-manager-1',
        });

        await service.replyToReview(
          'QPL-2026-0001',
          'co-manager-1',
          'review-1',
          { text: 'Thanks!' },
        );

        expect(reviewReplies.notifyReviewReplied).not.toHaveBeenCalled();
      });

      it('never fails the reply when the bell write fails', async () => {
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        reviews.findOne.mockResolvedValue({ ...baseReview });
        reviewReplies.notifyReviewReplied.mockRejectedValue(
          new Error('bell down'),
        );

        await expect(
          service.replyToReview('QPL-2026-0001', 'owner-1', 'review-1', {
            text: 'Thanks!',
          }),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('listQueue', () => {
    it('applies status/search/sort filters and computes per-status counts with one grouped query', async () => {
      const searchQb = qbStub();
      const countsQb = qbStub();
      countsQb.getRawMany.mockResolvedValue([
        { status: ListingStatus.Review, count: '2' },
        { status: ListingStatus.Live, count: '5' },
      ]);
      // `listQueue` builds two independent query builders (the page + the
      // counts) — see `createQueryBuilder`'s call order in the service.
      listings.createQueryBuilder
        .mockReturnValueOnce(searchQb)
        .mockReturnValueOnce(countsQb);

      const result = await service.listQueue({
        status: ListingStatus.Review,
        q: 'lux',
        sort: 'name',
      });

      // Joined on the owner, falling back to the suggester, so a moderator
      // searching a suggester's name still finds the suggestions they sent.
      expect(searchQb.leftJoin).toHaveBeenCalledWith(
        expect.anything(),
        'submitter',
        'submitter.user_id = COALESCE(l.owner_id, l.suggested_by_user_id)',
      );
      // Name and submitter first name are accent-folded; the ASCII ref keeps
      // its plain ILIKE. One assertion per branch, so dropping any of the
      // three fails here.
      expect(searchQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining(
          `(${foldedHaystack('l', LISTING_NAME_SEARCH_COLUMNS)} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        ) as unknown,
        { pattern: '%lux%' },
      );
      expect(searchQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining(
          `${foldedHaystack('submitter', ['first_name'])} LIKE ${foldedSearchTerm('pattern')}`,
        ) as unknown,
        { pattern: '%lux%' },
      );
      expect(searchQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining(' OR l.ref ILIKE :pattern)') as unknown,
        { pattern: '%lux%' },
      );
      expect(searchQb.orderBy).toHaveBeenCalledWith('l.name', 'ASC');
      // Exactly one grouped counts query — never one query per status.
      expect(countsQb.getRawMany).toHaveBeenCalledTimes(1);
      expect(result.counts).toEqual({
        all: 7,
        review: 2,
        question: 0,
        live: 5,
      });
    });

    it('credits the suggester on a suggestion the platform holds', async () => {
      const searchQb = qbStub();
      searchQb.getManyAndCount.mockResolvedValue([
        [
          baseListing({
            path: 'suggest',
            ownerId: null,
            suggestedByUserId: 'suggester-1',
          }),
        ],
        1,
      ]);
      listings.createQueryBuilder
        .mockReturnValueOnce(searchQb)
        .mockReturnValueOnce(qbStub());
      profiles.find.mockResolvedValue([
        {
          userId: 'suggester-1',
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const result = await service.listQueue({});

      const [row] = result.items;
      expect(row?.submittedBy).toBeNull();
      expect(row?.suggestedBy).toEqual(
        expect.objectContaining({ slug: 'bea-costa', firstName: 'Bea' }),
      );
      // Owners and suggesters resolve in one profile read.
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });

    it('credits the staff author on a listing an admin added', async () => {
      const searchQb = qbStub();
      searchQb.getManyAndCount.mockResolvedValue([
        [
          baseListing({
            path: 'admin-added',
            ownerId: null,
            suggestedByUserId: null,
            createdByStaffId: 'staff-1',
          }),
        ],
        1,
      ]);
      listings.createQueryBuilder
        .mockReturnValueOnce(searchQb)
        .mockReturnValueOnce(qbStub());
      profiles.find.mockResolvedValue([
        {
          userId: 'staff-1',
          slug: 'rui-staff',
          firstName: 'Rui',
          lastName: 'Staff',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const result = await service.listQueue({});

      const [row] = result.items;
      expect(row?.submittedBy).toBeNull();
      expect(row?.suggestedBy).toBeNull();
      expect(row?.addedByStaff).toEqual(
        expect.objectContaining({ slug: 'rui-staff', firstName: 'Rui' }),
      );
      // The staff author joins the same batched profile read.
      expect(profiles.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('findSimilar', () => {
    it('keeps an accented name match the folded query returned when no coordinates are given', async () => {
      const similarQb = qbStub();
      // The SQL branch folds accents, so the database hands back "Café Lux"
      // for "Cafe Lux"; the JS post-filter must agree with it.
      similarQb.getMany = jest.fn().mockResolvedValue([
        baseListing({
          name: 'Café Lux',
          slug: 'cafe-lux',
          status: ListingStatus.Live,
          cats: ['cafe'],
        }),
      ]);
      listings.createQueryBuilder.mockReturnValueOnce(similarQb);

      const result = await service.findSimilar('Cafe Lux');

      expect(result).toEqual([
        {
          name: 'Café Lux',
          cat: 'cafe',
          hood: 'Arroios',
          slug: 'cafe-lux',
          distanceM: null,
        },
      ]);
    });
  });

  describe('bulkSetStatus', () => {
    it('bulk-approves found refs to Live: records a bulk_status event, creates the ListingApproved notification (not a DM), and reports unknown refs as failed', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        slug: 'lux-cafe',
        status: ListingStatus.Review,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkSetStatus(
        ['QPL-2026-0001', 'QPL-2026-9999'],
        ListingStatus.Live,
        'mod-1',
        'batch approve',
      );

      expect(result).toEqual({
        updated: ['QPL-2026-0001'],
        failed: ['QPL-2026-9999'],
      });
      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ListingStatus.Live }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.BulkStatus,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
          reason: 'batch approve',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.ListingApproved,
        expect.objectContaining({ listingSlug: 'lux-cafe' }),
      );
      // Bulk approval creates the persisted notification, never a DM.
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('best-effort DMs each affected submitter and records the event on a non-approval bulk transition', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        name: 'Lux Café',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Review,
        'mod-1',
        'needs another look',
      );

      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          action: ListingModerationAction.BulkStatus,
          fromStatus: ListingStatus.Live,
          toStatus: ListingStatus.Review,
          reason: 'needs another look',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        expect.stringContaining('needs another look'),
      );
      // Not an approval — no persisted notification.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('notifies a suggester when a bulk transition sends their suggestion back', async () => {
      listings.find.mockResolvedValue([
        baseListing({
          ref: 'QPL-2026-0001',
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
          status: ListingStatus.Live,
        }),
      ]);

      await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Review,
        'mod-1',
        'needs another look',
      );

      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionSentBack,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
          reason: 'needs another look',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('tells a suggester with a bell notification when a bulk approval puts their suggestion live', async () => {
      listings.find.mockResolvedValue([
        baseListing({
          ref: 'QPL-2026-0001',
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
          status: ListingStatus.Review,
        }),
      ]);

      await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Live,
        'mod-1',
      );

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionLive,
        { source: 'listing', listingSlug: 'lux-cafe', listingName: 'Lux Café' },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('counts an already-at-target-status ref as updated but writes no event, DM, or notification', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkSetStatus(
        ['QPL-2026-0001'],
        ListingStatus.Live,
        'mod-1',
      );

      expect(result).toEqual({ updated: ['QPL-2026-0001'], failed: [] });
      expect(listings.save).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('bulkRemove', () => {
    it('removes found refs, records one removed event each, DMs submitters, and reports unknown refs as failed', async () => {
      const listing = baseListing({
        ref: 'QPL-2026-0001',
        ownerId: 'owner-1',
        name: 'Lux Café',
        status: ListingStatus.Live,
      });
      listings.find.mockResolvedValue([listing]);

      const result = await service.bulkRemove(
        ['QPL-2026-0001', 'QPL-2026-9999'],
        'mod-1',
        'policy violation',
      );

      expect(result).toEqual({
        updated: ['QPL-2026-0001'],
        failed: ['QPL-2026-9999'],
      });
      expect(listings.remove).toHaveBeenCalledWith(listing);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.Removed,
          fromStatus: ListingStatus.Live,
          toStatus: null,
          reason: 'policy violation',
        }),
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'mod-1',
        'owner-1',
        'Your listing "Lux Café" was removed from QueerPulse. Reason: policy violation',
      );
    });

    it('notifies a suggester when their suggestion is bulk-removed', async () => {
      listings.find.mockResolvedValue([
        baseListing({
          ref: 'QPL-2026-0001',
          path: 'suggest',
          ownerId: null,
          suggestedByUserId: 'suggester-1',
          name: 'Lux Café',
        }),
      ]);

      await service.bulkRemove(['QPL-2026-0001'], 'mod-1', 'policy violation');

      expect(notifications.create).toHaveBeenCalledWith(
        'suggester-1',
        NotificationType.ListingSuggestionRemoved,
        {
          source: 'listing',
          listingRef: 'QPL-2026-0001',
          listingName: 'Lux Café',
          reason: 'policy violation',
        },
      );
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });
  });

  describe('getListingHistory', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(
        service.getListingHistory('QPL-2026-9999'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns events and questions, both newest-first per the repo query', async () => {
      listings.findOne.mockResolvedValue(baseListing());
      moderationEvents.find.mockResolvedValue([
        {
          id: 'event-1',
          listingId: 'listing-1',
          actorId: 'mod-1',
          action: ListingModerationAction.StatusChanged,
          fromStatus: ListingStatus.Review,
          toStatus: ListingStatus.Live,
          reason: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);
      questions.find.mockResolvedValue([
        {
          id: 'question-1',
          listingId: 'listing-1',
          askedBy: 'mod-1',
          body: 'What are your hours?',
          answer: null,
          answeredAt: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);

      const history = await service.getListingHistory('QPL-2026-0001');

      expect(moderationEvents.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
      expect(questions.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { createdAt: 'DESC' } }),
      );
      expect(history.events).toHaveLength(1);
      expect(history.events[0]?.action).toBe(
        ListingModerationAction.StatusChanged,
      );
      expect(history.questions).toHaveLength(1);
      expect(history.questions[0]?.body).toBe('What are your hours?');
    });
  });

  describe('getOwnerListingHistory', () => {
    const ownerEditedEvent = {
      id: 'event-owner-edit',
      listingId: 'listing-1',
      actorId: 'owner-1',
      action: ListingModerationAction.OwnerEdited,
      fromStatus: null,
      toStatus: null,
      reason: 'The owner updated the opening hours.',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    };
    const sentBackEvent = {
      id: 'event-sent-back',
      listingId: 'listing-1',
      actorId: 'mod-1',
      action: ListingModerationAction.StatusChanged,
      fromStatus: ListingStatus.Live,
      toStatus: ListingStatus.Review,
      reason: 'Internal note: owner has a prior warning on file.',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    const transferEvent = {
      id: 'event-transfer',
      listingId: 'listing-1',
      actorId: 'mod-1',
      action: ListingModerationAction.OwnershipTransferred,
      fromStatus: null,
      toStatus: null,
      reason:
        "Ownership transferred on an approved claim. Claimant's note: I am Ana, I manage the bar.",
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('404s a caller who does not own the listing, without reading any event', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );

      await expect(
        service.getOwnerListingHistory('QPL-2026-0001', 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moderationEvents.findAndCount).not.toHaveBeenCalled();
    });

    it('scopes the read to the listing and pages newest-first', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      moderationEvents.findAndCount.mockResolvedValue([[ownerEditedEvent], 41]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-1',
        2,
      );

      // The seat check moved off the query and into
      // `loadOwnedOrCoManagedOr404`, which loads by `ref` alone and then
      // decides owner / co-manager / 404. `listing-co-manager-permissions.spec`
      // holds the access side of that gate.
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: 'QPL-2026-0001' },
      });
      expect(moderationEvents.findAndCount).toHaveBeenCalledWith({
        where: { listingId: 'listing-1' },
        order: { createdAt: 'DESC' },
        skip: 20,
        take: 20,
      });
      // The team's accepted seats are read on the same listing, with only the
      // two columns the current-team filter needs.
      expect(coManagerSeats.find).toHaveBeenCalledWith({
        where: { listingId: 'listing-1', acceptedAt: Not(IsNull()) },
        select: { userId: true, endedAt: true },
      });
      // The latest transfer is read on the same listing, timestamp only.
      expect(moderationEvents.findOne).toHaveBeenCalledWith({
        where: {
          listingId: 'listing-1',
          action: ListingModerationAction.OwnershipTransferred,
        },
        order: { createdAt: 'DESC' },
        select: { createdAt: true },
      });
      // With no transfer on the listing, the whole Q&A thread comes back.
      expect(questions.find).toHaveBeenCalledWith({
        where: { listingId: 'listing-1' },
        order: { createdAt: 'DESC' },
        take: DEFAULT_LIST_LIMIT,
      });
      expect(history.page).toBe(2);
      expect(history.pageSize).toBe(20);
      expect(history.totalEvents).toBe(41);
    });

    it("shows the platform-composed owner_edited reason, so the owner sees their own edit's audit row", async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      moderationEvents.findAndCount.mockResolvedValue([[ownerEditedEvent], 1]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(history.events[0]?.reason).toBe(
        'The owner updated the opening hours.',
      );
      expect(history.events[0]?.hasModeratorNote).toBe(false);
    });

    it("withholds a moderator's note and the claimant's transfer note, flagging only the note that was DM'd", async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      moderationEvents.findAndCount.mockResolvedValue([
        [sentBackEvent, transferEvent],
        2,
      ]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(history.events[0]?.reason).toBeNull();
      // The send-back note reached the owner through `setStatus`'s DM.
      expect(history.events[0]?.hasModeratorNote).toBe(true);
      expect(history.events[1]?.reason).toBeNull();
      // The transfer note was never messaged to the owner, so no flag.
      expect(history.events[1]?.hasModeratorNote).toBe(false);
      // The claimant's self-identifying note must not appear anywhere in the
      // payload, in any field.
      expect(JSON.stringify(history)).not.toContain('Ana');
    });

    it('reads a staff row as moderation and looks up no profile for it', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      moderationEvents.findAndCount.mockResolvedValue([[sentBackEvent], 1]);
      questions.find.mockResolvedValue([
        {
          id: 'question-1',
          listingId: 'listing-1',
          askedBy: 'mod-1',
          body: 'What are your hours?',
          answer: null,
          answeredAt: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(history.events[0]?.actor).toEqual({ kind: 'moderation' });
      expect(history.questions[0]).not.toHaveProperty('askedBy');
      expect(history.questions[0]?.body).toBe('What are your hours?');
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('hides who made team edits before the latest transfer and names the current team after it', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-2' }));
      const olderOwnerEdit = {
        ...ownerEditedEvent,
        id: 'event-old-owner-edit',
        actorId: 'owner-1',
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
      };
      const newerOwnerEdit = {
        ...ownerEditedEvent,
        id: 'event-new-owner-edit',
        actorId: 'owner-2',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      };
      moderationEvents.findAndCount.mockResolvedValue([
        [newerOwnerEdit, transferEvent, olderOwnerEdit],
        3,
      ]);
      moderationEvents.findOne.mockResolvedValue({
        createdAt: transferEvent.createdAt,
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'owner-2',
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-2',
      );

      expect(history.events[0]?.actor).toEqual({
        kind: 'team',
        member: {
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          pronouns: null,
          avatarUrl: null,
        },
      });
      expect(history.events[1]?.actor).toEqual({ kind: 'moderation' });
      expect(history.events[2]?.actor).toEqual({ kind: 'previous_team' });
      // Only the current team's actor is looked up; the previous owner and
      // the moderator who ran the transfer never reach the profile read.
      expect(profiles.find).toHaveBeenCalledTimes(1);
      const [profileQuery] = profiles.find.mock.calls[0] as [
        { where: { userId: { value: string[] } } },
      ];
      expect(profileQuery.where.userId.value).toEqual(['owner-2']);
    });

    it('reads a pre-transfer row as the previous team on a page that does not hold the transfer', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-2' }));
      const olderOwnerEdit = {
        ...ownerEditedEvent,
        id: 'event-old-owner-edit',
        actorId: 'owner-1',
        createdAt: new Date('2025-12-31T00:00:00.000Z'),
      };
      moderationEvents.findAndCount.mockResolvedValue([[olderOwnerEdit], 21]);
      moderationEvents.findOne.mockResolvedValue({
        createdAt: transferEvent.createdAt,
      });

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-2',
        2,
      );

      expect(history.events[0]?.actor).toEqual({ kind: 'previous_team' });
      expect(history.events[0]?.reason).toBeNull();
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('keeps an admin who revoked a seat unnamed and names a current co-manager', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      coManagerSeats.find.mockResolvedValue([
        { userId: 'co-manager-1', endedAt: null },
      ]);
      const adminRevokeEvent = {
        id: 'event-admin-revoke',
        listingId: 'listing-1',
        actorId: 'admin-1',
        action: ListingModerationAction.CoManagerRemoved,
        fromStatus: null,
        toStatus: null,
        reason: 'Rui Alves was removed as a co-manager of this listing.',
        createdAt: new Date('2026-01-04T00:00:00.000Z'),
      };
      const coManagerEdit = {
        ...ownerEditedEvent,
        id: 'event-co-manager-edit',
        actorId: 'co-manager-1',
      };
      moderationEvents.findAndCount.mockResolvedValue([
        [adminRevokeEvent, coManagerEdit],
        2,
      ]);
      profiles.find.mockResolvedValue([
        {
          userId: 'co-manager-1',
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-1',
      );

      expect(history.events[0]?.actor).toEqual({ kind: 'moderation' });
      expect(history.events[1]?.actor).toEqual({
        kind: 'team',
        member: {
          slug: 'bea-costa',
          firstName: 'Bea',
          lastName: 'Costa',
          pronouns: null,
          avatarUrl: null,
        },
      });
      // The admin's id never reaches the profile read.
      expect(profiles.find).toHaveBeenCalledTimes(1);
      const [profileQuery] = profiles.find.mock.calls[0] as [
        { where: { userId: { value: string[] } } },
      ];
      expect(profileQuery.where.userId.value).toEqual(['co-manager-1']);
    });

    it('reads a member whose seat ended at the transfer as moderation on a later team action', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-2' }));
      moderationEvents.findOne.mockResolvedValue({
        createdAt: transferEvent.createdAt,
      });
      // Revoked by the transfer itself, so the seat ended at its instant.
      coManagerSeats.find.mockResolvedValue([
        { userId: 'former-co-manager', endedAt: transferEvent.createdAt },
      ]);
      const laterSeatEvent = {
        id: 'event-later-seat-change',
        listingId: 'listing-1',
        actorId: 'former-co-manager',
        action: ListingModerationAction.CoManagerRemoved,
        fromStatus: null,
        toStatus: null,
        reason: 'Rui Alves was removed as a co-manager of this listing.',
        createdAt: new Date('2026-01-05T00:00:00.000Z'),
      };
      moderationEvents.findAndCount.mockResolvedValue([[laterSeatEvent], 1]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-2',
      );

      expect(history.events[0]?.actor).toEqual({ kind: 'moderation' });
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('returns only the questions asked after the latest transfer', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-2' }));
      moderationEvents.findOne.mockResolvedValue({
        createdAt: transferEvent.createdAt,
      });
      questions.find.mockResolvedValue([
        {
          id: 'question-after-transfer',
          listingId: 'listing-1',
          askedBy: 'mod-1',
          body: 'Are the new opening hours final?',
          answer: null,
          answeredAt: null,
          createdAt: new Date('2026-01-06T00:00:00.000Z'),
        },
      ]);

      const history = await service.getOwnerListingHistory(
        'QPL-2026-0001',
        'owner-2',
      );

      // The boundary is in the query, so the previous owner's answers never
      // leave the database.
      expect(questions.find).toHaveBeenCalledWith({
        where: {
          listingId: 'listing-1',
          createdAt: MoreThan(transferEvent.createdAt),
        },
        order: { createdAt: 'DESC' },
        take: DEFAULT_LIST_LIMIT,
      });
      expect(history.questions).toHaveLength(1);
      expect(history.questions[0]?.id).toBe('question-after-transfer');
    });
  });

  describe('answerQuestion', () => {
    it('404s a non-owner', async () => {
      scopeFindOneToOwner(
        listings.findOne,
        'owner-1',
        baseListing({ ownerId: 'owner-1' }),
      );
      await expect(
        service.answerQuestion(
          'QPL-2026-0001',
          'question-1',
          'someone-else',
          'Sure, opens at 9am.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a question that does not belong to this listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      questions.findOne.mockResolvedValue(null);

      await expect(
        service.answerQuestion(
          'QPL-2026-0001',
          'question-1',
          'owner-1',
          'Sure, opens at 9am.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets the answer + timestamp and records an answered event', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      questions.findOne.mockResolvedValue({
        id: 'question-1',
        listingId: 'listing-1',
        askedBy: 'mod-1',
        body: 'What are your hours?',
        answer: null,
        answeredAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const dto = await service.answerQuestion(
        'QPL-2026-0001',
        'question-1',
        'owner-1',
        'We open at 9am.',
      );

      expect(dto.answer).toBe('We open at 9am.');
      expect(dto.answeredAt).toEqual(expect.any(String) as unknown);
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: ListingModerationAction.Answered }),
      );
    });
  });

  describe('answerPublicQuestion', () => {
    const openQuestion = () => ({
      id: 'public-question-1',
      listingId: 'listing-1',
      askerId: 'asker-1',
      askerName: 'Ana Silva',
      body: 'Is the entrance step-free?',
      answer: null,
      answeredAt: null,
      answeredById: null,
      isAnsweredByModerator: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    it('404s a question that belongs to a different listing', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      // The lookup is scoped to this listing, so a guessed id from another
      // owner's listing simply does not resolve.
      publicQuestions.findOne.mockResolvedValue(null);

      await expect(
        service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the caller does not own the listing', async () => {
      // `loadOwnedOr404` folds ownership into the query, so a non-owner gets
      // nothing back and never learns the listing exists.
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'someone-else',
          'Yes.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a whitespace-only answer post-trim', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      publicQuestions.findOne.mockResolvedValue(openQuestion());

      await expect(
        service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          '   ',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(publicQuestions.save).not.toHaveBeenCalled();
    });

    it("records an owner answer as the OWNER's, and tells the asker", async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      publicQuestions.findOne.mockResolvedValue(openQuestion());

      const dto = await service.answerPublicQuestion(
        'QPL-2026-0001',
        'public-question-1',
        'owner-1',
        '  Yes, the entrance is step-free.  ',
      );

      expect(dto.answer).toBe('Yes, the entrance is step-free.');
      expect(dto.answeredByRole).toBe('owner');
      expect(publicQuestions.save).toHaveBeenCalledWith(
        expect.objectContaining({
          answeredById: 'owner-1',
          isAnsweredByModerator: false,
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'asker-1',
        NotificationType.ListingPublicQuestionAnswered,
        expect.objectContaining({
          source: 'listing',
          listingSlug: 'lux-cafe',
          listingName: 'Lux Café',
        }),
        // The block/mute gate still keys on the real answerer, whether or not
        // the row is allowed to name them.
        'owner-1',
      );
    });

    /**
     * The public Q&A attributes an answer by ROLE only
     * (`answeredByRole: 'owner' | 'moderator'`), so the bell must not hand the
     * asker an identity the page they asked on withholds. An actor on this row
     * is the answerer's name, face and a link to their profile.
     */
    describe('naming the answerer to the asker', () => {
      /** The payload of the one `notifications.create` call, for the tests
       *  below that care whether `actorId` is in it. */
      const answeredPayload = () => {
        const call = notifications.create.mock.calls[0] as [
          string,
          NotificationType,
          Record<string, unknown>,
          string | undefined,
        ];
        return call[2];
      };

      it('names an owner whose public page already links their profile', async () => {
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'public',
            linkToProfile: true,
          }),
        );
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        );

        expect(answeredPayload()).toHaveProperty('actorId', 'owner-1');
      });

      it('never names an owner who chose to stay anonymous', async () => {
        // `visibility: 'anon'` is a safety decision about being publicly known
        // as a queer business owner. An actor on this row would undo it from a
        // page that names nobody.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'anon',
            linkToProfile: true,
          }),
        );
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        );

        expect(answeredPayload()).not.toHaveProperty('actorId');
      });

      it('never names an owner who publishes only their role', async () => {
        // `visibility: 'role'` publishes "co-founder and baker" and refuses the
        // real name, the first name and the profile link alike.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'role',
            linkToProfile: true,
          }),
        );
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        );

        expect(answeredPayload()).not.toHaveProperty('actorId');
      });

      it('never names an owner who withheld the profile link', async () => {
        // A `public` listing still prints `ownerName` as free text, and that is
        // not the same consent: an actor is a route to the member's profile,
        // which is exactly what `linkToProfile: false` refuses.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'public',
            linkToProfile: false,
          }),
        );
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        );

        expect(answeredPayload()).not.toHaveProperty('actorId');
      });

      it('never names a co-manager, who is invisible on the public page', async () => {
        // Regardless of the OWNER's visibility: the co-manager seat itself is
        // never published, so naming the person who typed the answer would
        // reveal a relationship the page does not carry at all.
        listings.findOne.mockResolvedValue(
          baseListing({
            ownerId: 'owner-1',
            visibility: 'public',
            linkToProfile: true,
          }),
        );
        coManagers.isActiveCoManager.mockResolvedValue(true);
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'co-manager-1',
          'Yes.',
        );

        expect(answeredPayload()).not.toHaveProperty('actorId');
        // The block/mute gate still keys on them, so an asker who blocked this
        // co-manager is not reached even though the row will not name them.
        const call = notifications.create.mock.calls[0] as [
          string,
          NotificationType,
          Record<string, unknown>,
          string | undefined,
        ];
        expect(call[3]).toBe('co-manager-1');
      });

      it('still answers usefully with no actor: the deep link survives', async () => {
        // The asker is owed the ANSWER. Withholding the name must not leave a
        // row with nothing in it: `source` + `listingSlug` build the link to
        // the page the answer is published on, and `listingName` is the
        // business's own public name.
        listings.findOne.mockResolvedValue(
          baseListing({ ownerId: 'owner-1', visibility: 'anon' }),
        );
        publicQuestions.findOne.mockResolvedValue(openQuestion());

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        );

        expect(answeredPayload()).toEqual({
          source: 'listing',
          listingSlug: 'lux-cafe',
          listingName: 'Lux Café',
        });
      });

      it('does not notify a co-manager who answered their own question', async () => {
        // Reachable: `askQuestion` blocks the OWNER from asking, so a member
        // can ask and later take a co-manager seat on the same listing. The
        // guard reads the real answerer rather than the published actor, which
        // is null for a co-manager.
        listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
        coManagers.isActiveCoManager.mockResolvedValue(true);
        publicQuestions.findOne.mockResolvedValue({
          ...openQuestion(),
          askerId: 'co-manager-1',
        });

        await service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'co-manager-1',
          'Yes.',
        );

        expect(notifications.create).not.toHaveBeenCalled();
      });
    });

    it('never lets a moderator answer read as the business speaking', async () => {
      // `Listing.ownerId` is typed non-nullable on the entity while the column
      // is nullable in the database (a suggestion the platform holds carries
      // no owner). The cast keeps this fixture honest about the real row
      // shape while leaving an entity this work does not own untouched.
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: null as unknown as string }),
      );
      publicQuestions.findOne.mockResolvedValue(openQuestion());

      const dto = await service.answerPublicQuestionAsModerator(
        'QPL-2026-0001',
        'public-question-1',
        'moderator-1',
        'We checked with the venue: yes.',
      );

      expect(dto.answeredByRole).toBe('moderator');
      expect(publicQuestions.save).toHaveBeenCalledWith(
        expect.objectContaining({ isAnsweredByModerator: true }),
      );
    });

    it('names no actor on a moderator answer, so the asker is not told which staff member wrote it', async () => {
      // `Listing.ownerId` is typed non-nullable on the entity while the column
      // is nullable in the database (a suggestion the platform holds carries
      // no owner). The cast keeps this fixture honest about the real row
      // shape while leaving an entity this work does not own untouched.
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: null as unknown as string }),
      );
      publicQuestions.findOne.mockResolvedValue(openQuestion());

      await service.answerPublicQuestionAsModerator(
        'QPL-2026-0001',
        'public-question-1',
        'moderator-1',
        'We checked with the venue: yes.',
      );

      const call = notifications.create.mock.calls[0] as [
        string,
        NotificationType,
        Record<string, unknown>,
        string | undefined,
      ];
      expect(call[0]).toBe('asker-1');
      expect(call[2]).not.toHaveProperty('actorId');
      expect(call[3]).toBeUndefined();
    });

    it('still answers when the asker erased their account (nobody left to notify)', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      publicQuestions.findOne.mockResolvedValue({
        ...openQuestion(),
        askerId: null,
      });

      const dto = await service.answerPublicQuestion(
        'QPL-2026-0001',
        'public-question-1',
        'owner-1',
        'Yes.',
      );

      expect(dto.answer).toBe('Yes.');
      expect(dto.askerSlug).toBeNull();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('never blocks the answer on a failed notification', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownerId: 'owner-1' }));
      publicQuestions.findOne.mockResolvedValue(openQuestion());
      notifications.create.mockRejectedValue(new Error('bell is down'));

      await expect(
        service.answerPublicQuestion(
          'QPL-2026-0001',
          'public-question-1',
          'owner-1',
          'Yes.',
        ),
      ).resolves.toEqual(expect.objectContaining({ answer: 'Yes.' }));
    });
  });
});
