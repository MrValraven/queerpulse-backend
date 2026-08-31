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
import { DataSource, EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { ReportsService } from '../reports/reports.service';
import { CreateListingDto } from './dto/create-listing.dto';
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
import { ListingCoManagersService } from './listing-co-managers.service';
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
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let coManagers: {
    isActiveCoManager: jest.Mock;
    listingIdsCoManagedBy: jest.Mock;
  };
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
      // `partners.service.spec.ts`'s identical precedent).
      save: jest.fn((v: object) =>
        Promise.resolve({
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
    coManagers = {
      isActiveCoManager: jest.fn().mockResolvedValue(false),
      listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
    };
    transactionManager = buildTransactionManager(listings);
    dataSource = {
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
        // reports pipeline. `create` is only reached for friendly/suggested
        // listings, so a bare mock suffices for the existing cases.
        { provide: ReportsService, useValue: { create: jest.fn() } },
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

    // Finding M1: `ListingsController.update` keeps the interceptor's
    // foreign-upload exemption (a claimed listing has more than one editor),
    // so the service is the line that stops a member introducing a NEW photo
    // that is not theirs while still letting a co-editor re-save one a
    // different collaborator uploaded.
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

      expect(searchQb.leftJoin).toHaveBeenCalled();
      expect(searchQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE') as unknown,
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
        expect.stringContaining('policy violation'),
      );
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

    it("withholds a moderator's internal note and the claimant's transfer note, flagging only that a note exists", async () => {
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
      expect(history.events[0]?.hasModeratorNote).toBe(true);
      expect(history.events[1]?.reason).toBeNull();
      expect(history.events[1]?.hasModeratorNote).toBe(true);
      // The claimant's self-identifying note must not appear anywhere in the
      // payload, in any field.
      expect(JSON.stringify(history)).not.toContain('Ana');
    });

    it('never carries an actor on any row, and never resolves a profile to build one', async () => {
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

      expect(history.events[0]).not.toHaveProperty('actor');
      expect(history.questions[0]).not.toHaveProperty('askedBy');
      expect(history.questions[0]?.body).toBe('What are your hours?');
      expect(profiles.find).not.toHaveBeenCalled();
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

    it("records an owner answer as the OWNER's, and notifies the asker with the owner as actor", async () => {
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
        expect.objectContaining({ actorId: 'owner-1', source: 'listing' }),
        'owner-1',
      );
    });

    it('never lets a moderator answer read as the business speaking', async () => {
      // `Listing.ownerId` is typed non-nullable on the entity while the column
      // is nullable in the database (`friendly`/`suggested` rows carry no
      // owner) — the cast keeps this fixture honest about the real row shape
      // without changing an entity this work does not own.
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
      // is nullable in the database (`friendly`/`suggested` rows carry no
      // owner) — the cast keeps this fixture honest about the real row shape
      // without changing an entity this work does not own.
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
