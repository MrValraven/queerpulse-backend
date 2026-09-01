import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { StorageService } from '../storage/storage.service';
import { Profile } from '../users/entities/profile.entity';
import { ListingModerationEvent } from './entities/listing-moderation-event.entity';
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
import {
  ListingManagementRole,
  OWNER_PERSONAL_LISTING_FIELDS,
} from './listing-owner-personal-fields';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { ListingsService } from './listings.service';

/**
 * THE PERMISSION BOUNDARY between a listing's owner and its co-managers, tested
 * at the service where both gates live.
 *
 * There are exactly two gates on a listing's management routes and the whole
 * feature is the line between them:
 *
 *  - `loadOwnedOr404` — owner only. Deleting the listing, and the moderator
 *    compliance Q&A.
 *  - `loadOwnedOrCoManagedOr404` — owner or active co-manager. Everything a
 *    person does to run the business day to day.
 *
 * A route that quietly moves to the wrong one is either a co-manager who cannot
 * do their job or a privilege escalation, so each direction is asserted here
 * rather than left to a reading of the call sites.
 */

const OWNER_ID = 'owner-1';
const CO_MANAGER_ID = 'co-manager-1';
const STRANGER_ID = 'stranger-1';

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  ownerId: OWNER_ID,
  status: ListingStatus.Live,
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
  photos: { wide: '', d1: '', d2: '', vibe: '' },
  alt: { wide: '', d1: '', d2: '', vibe: '' },
  rel: 'owner',
  ownerName: 'Ana Ribeiro',
  ownerRole: 'Co-founder and baker',
  ownerBio: 'Runs the place since 2019.',
  visibility: 'public',
  linkToProfile: true,
  contactEmail: 'ana@example.com',
  notify: [],
  consentOuting: true,
  consentGuide: true,
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

interface QueryBuilderStub extends Record<string, jest.Mock> {
  getManyAndCount: jest.Mock;
}

const qbStub = (rows: Listing[] = []): QueryBuilderStub => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'orWhere',
    'leftJoin',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
  return qb as QueryBuilderStub;
};

describe('listing co-manager permission boundary', () => {
  let service: ListingsService;
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let questions: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let coManagers: {
    isActiveCoManager: jest.Mock;
    listingIdsCoManagedBy: jest.Mock;
  };
  let transactionManager: {
    save: jest.Mock;
    remove: jest.Mock;
    getRepository: jest.Mock;
  };

  /**
   * A listing edit commits down one of two paths: a LIVE listing whose edit
   * actually moved a field saves inside `dataSource.transaction`, so the
   * `owner_edited` audit row lands with it, and everything else falls back to
   * the plain repository save. Either one means the write happened, so the
   * permission assertions below ask this rather than naming one path.
   */
  const hasSavedTheListing = () =>
    listings.save.mock.calls.length > 0 ||
    transactionManager.save.mock.calls.length > 0;

  /** Loads by `ref` alone, exactly as `loadOr404` does, so a test that expects
   * a 404 for a non-owner is proving the SEAT check rather than an empty
   * result set. */
  const listingExists = (listing: Listing) =>
    listings.findOne.mockImplementation(
      (options?: { where?: { ownerId?: string } }) =>
        Promise.resolve(
          options?.where?.ownerId === undefined ||
            options.where.ownerId === listing.ownerId
            ? listing
            : null,
        ),
    );

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: object) =>
        Promise.resolve({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...value,
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    questions = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((value: object) => Promise.resolve(value)),
    };
    coManagers = {
      isActiveCoManager: jest.fn().mockResolvedValue(false),
      listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
    };

    transactionManager = {
      save: jest.fn((first: unknown, second?: object) =>
        Promise.resolve(
          second !== undefined ? { id: 'event-1', ...second } : first,
        ),
      ),
      remove: jest.fn((entity: object) => Promise.resolve(entity)),
      getRepository: jest.fn(() => listings),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: getRepositoryToken(ListingReview),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(ListingModerationEvent),
          useValue: {
            save: jest.fn((value: object) => Promise.resolve(value)),
            find: jest.fn().mockResolvedValue([]),
            findAndCount: jest.fn().mockResolvedValue([[], 0]),
          },
        },
        { provide: getRepositoryToken(ListingQuestion), useValue: questions },
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
            save: jest.fn(),
            count: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([{ seq: '1' }]),
            transaction: jest.fn(
              (work: (manager: EntityManager) => Promise<unknown>) =>
                work(transactionManager as unknown as EntityManager),
            ),
          },
        },
        { provide: MessagingService, useValue: { deliverEnquiry: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: StorageService,
          useValue: { deleteObjectByReference: jest.fn() },
        },
        { provide: ReportsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: ListingCoManagersService, useValue: coManagers },
        // PRD-47: `replyToReview`'s bell emit. Nothing in this file calls
        // it; the provider exists so `ListingsService` still resolves.
        {
          provide: ReviewReplyNotifier,
          useValue: { notifyReviewReplied: jest.fn() },
        },
        // The listing-claim queue announcement. Nothing in this file reaches
        // it either; the provider exists so `ListingsService` still resolves.
        {
          provide: AdminQueueNotificationsService,
          useValue: { announce: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get(ListingsService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  // ---------------------------------------------------------------------------
  // THE ONE THAT MATTERS MOST: owner-personal fields on WRITE.
  // ---------------------------------------------------------------------------

  describe('a co-manager cannot write an owner-personal field', () => {
    beforeEach(() => {
      listingExists(baseListing());
      coManagers.isActiveCoManager.mockResolvedValue(true);
    });

    it.each([...OWNER_PERSONAL_LISTING_FIELDS])(
      'rejects a co-manager PATCH carrying %s with 403',
      async (field) => {
        await expect(
          service.update('QPL-2026-0001', CO_MANAGER_ID, {
            name: 'Lux Café',
            [field]: field === 'contactEmail' ? 'attacker@example.com' : 'x',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it('writes NOTHING when it refuses', async () => {
      // Hiding the fields on read while leaving them patchable would be a hole
      // rather than a policy, so the refusal has to land before any merge or
      // save, not after one.
      await expect(
        service.update('QPL-2026-0001', CO_MANAGER_ID, {
          contactEmail: 'attacker@example.com',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(hasSavedTheListing()).toBe(false);
    });

    it('rejects consentOuting: false, which is a real consent withdrawal', async () => {
      await expect(
        service.update('QPL-2026-0001', CO_MANAGER_ID, {
          consentOuting: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('still lets the co-manager edit ordinary business fields', async () => {
      const result = await service.update('QPL-2026-0001', CO_MANAGER_ID, {
        name: 'Lux Café Bakery',
        hoursNote: 'Closed on public holidays',
      });

      expect(hasSavedTheListing()).toBe(true);
      expect(result.managementRole).toBe(ListingManagementRole.CoManager);
    });

    it('lets the OWNER write the very fields the co-manager cannot', async () => {
      await service.update('QPL-2026-0001', OWNER_ID, {
        contactEmail: 'ana@example.com',
        consentOuting: false,
      });

      expect(hasSavedTheListing()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Owner-personal fields on READ.
  // ---------------------------------------------------------------------------

  describe('a co-manager never receives an owner-personal field', () => {
    beforeEach(() => {
      listingExists(baseListing());
      coManagers.isActiveCoManager.mockResolvedValue(true);
    });

    it('omits all eight from GET /listings/:ref', async () => {
      const result = (await service.getByRef(
        'QPL-2026-0001',
        CO_MANAGER_ID,
      )) as unknown as Record<string, unknown>;

      expect(result.managementRole).toBe(ListingManagementRole.CoManager);
      for (const field of OWNER_PERSONAL_LISTING_FIELDS) {
        expect(field in result).toBe(false);
      }
      // The business itself is fully present, including the owner-shaped field
      // that is deliberately outside the set.
      expect(result.name).toBe('Lux Café');
      expect(result.ownerRole).toBe('Co-founder and baker');
    });

    it('omits them from a write that echoes the listing back', async () => {
      const result = (await service.setDirectoryVisibility(
        'QPL-2026-0001',
        CO_MANAGER_ID,
        { isHiddenByOwner: true },
      )) as unknown as Record<string, unknown>;

      expect('contactEmail' in result).toBe(false);
      expect('ownerBio' in result).toBe(false);
    });

    it('gives the owner all eight, and tags the seat as owner', async () => {
      const result = (await service.getByRef(
        'QPL-2026-0001',
        OWNER_ID,
      )) as unknown as Record<string, unknown>;

      expect(result.managementRole).toBe(ListingManagementRole.Owner);
      expect(result.contactEmail).toBe('ana@example.com');
      expect(result.ownerBio).toBe('Runs the place since 2019.');
    });
  });

  // ---------------------------------------------------------------------------
  // Route classification: which gate each act is behind.
  // ---------------------------------------------------------------------------

  describe('routes a co-manager MAY reach', () => {
    beforeEach(() => {
      listingExists(baseListing());
      coManagers.isActiveCoManager.mockResolvedValue(true);
    });

    it('confirm details', async () => {
      await expect(
        service.confirmDetails('QPL-2026-0001', CO_MANAGER_ID),
      ).resolves.toMatchObject({ ref: 'QPL-2026-0001' });
    });

    it('pause the listing in the directory', async () => {
      await expect(
        service.setDirectoryVisibility('QPL-2026-0001', CO_MANAGER_ID, {
          isHiddenByOwner: true,
        }),
      ).resolves.toBeDefined();
    });

    it('read the owner history', async () => {
      await expect(
        service.getOwnerListingHistory('QPL-2026-0001', CO_MANAGER_ID),
      ).resolves.toBeDefined();
    });
  });

  describe('routes a co-manager may NOT reach', () => {
    beforeEach(() => {
      listingExists(baseListing());
      coManagers.isActiveCoManager.mockResolvedValue(true);
    });

    it('cannot delete the listing', async () => {
      // `remove` stays on `loadOwnedOr404`, which folds ownership into the
      // query, so the seat is never even consulted: the co-manager gets the
      // same 404 a stranger does.
      await expect(
        service.remove('QPL-2026-0001', CO_MANAGER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(listings.remove).not.toHaveBeenCalled();
    });

    it('cannot answer a moderator compliance question', async () => {
      await expect(
        service.answerQuestion(
          'QPL-2026-0001',
          'question-1',
          CO_MANAGER_ID,
          'We own the building.',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(questions.save).not.toHaveBeenCalled();
    });

    it('lets the owner do both of those', async () => {
      await expect(
        service.remove('QPL-2026-0001', OWNER_ID),
      ).resolves.toBeUndefined();
      expect(listings.remove).toHaveBeenCalled();
    });
  });

  describe('a stranger reaches nothing, and cannot tell the ref exists', () => {
    beforeEach(() => {
      listingExists(baseListing());
      coManagers.isActiveCoManager.mockResolvedValue(false);
    });

    it('404s rather than 403s on a co-manager-allowed route', async () => {
      // Refs are a monotonic sequence, so a 403-vs-404 split would be an
      // existence oracle a member could enumerate.
      await expect(
        service.getByRef('QPL-2026-0001', STRANGER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s on an owner-only route', async () => {
      await expect(
        service.remove('QPL-2026-0001', STRANGER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never pays for a seat lookup when the caller is the owner', async () => {
      await service.getByRef('QPL-2026-0001', OWNER_ID);

      expect(coManagers.isActiveCoManager).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // "Which listings are mine".
  // ---------------------------------------------------------------------------

  describe('listMine', () => {
    it('includes co-managed listings, tagged apart from owned ones', async () => {
      const owned = baseListing();
      const coManaged = baseListing({
        id: 'listing-2',
        ref: 'QPL-2026-0002',
        slug: 'other-bar',
        ownerId: 'someone-else',
      });
      coManagers.listingIdsCoManagedBy.mockResolvedValue(['listing-2']);
      listings.createQueryBuilder.mockReturnValue(qbStub([owned, coManaged]));

      const page = await service.listMine(OWNER_ID, {});

      expect(page.items).toHaveLength(2);
      const [first, second] = page.items as unknown as Record<
        string,
        unknown
      >[];
      expect(first?.managementRole).toBe(ListingManagementRole.Owner);
      expect(first?.contactEmail).toBe('ana@example.com');
      expect(second?.managementRole).toBe(ListingManagementRole.CoManager);
      // Redaction is decided per row, so the co-managed row on the SAME page is
      // still missing every owner-personal field.
      expect(second && 'contactEmail' in second).toBe(false);
    });

    it('asks for the caller’s co-managed ids before building the page', async () => {
      await service.listMine(OWNER_ID, {});

      expect(coManagers.listingIdsCoManagedBy).toHaveBeenCalledWith(OWNER_ID);
    });
  });
});
