import {
  ArgumentMetadata,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { StorageService } from '../storage/storage.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminListingsController } from './admin-listings.controller';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
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
import { ListingManagementRole } from './listing-owner-personal-fields';
import { ListingsService } from './listings.service';

/**
 * STAFF EDITING A LISTING THE PLATFORM HOLDS.
 *
 * A suggestion, or a page the house wrote, has no owner until somebody takes
 * it over, so the admins are the only people who can correct it. Four things
 * have to hold for that to be safe, and each has a test here. The edit is
 * refused once the listing has an owner, and the refusal is decided on a
 * locked row so a claim approved at the same moment cannot be overwritten.
 * Every staff edit leaves a `staff_edited` audit row with the admin's name on
 * it, live or not. The edit never moves the moderation status. And the
 * owner's own `update`, which now shares the edit core, still audits only a
 * live listing.
 */

const STAFF_ID = 'staff-1';
const OWNER_ID = 'owner-id';
const LISTING_REF = 'QPL-2026-0001';
const OLD_PHOTO_KEY = 'listings/staff-1/old-cover.jpg';
// Well-formed storage keys, so the foreign-upload rule can read who uploaded
// each one (`<prefix>/<ownerUserId>/<uuid><ext>`).
const STAFF_UUID = '5a1f0000-0000-4000-8000-000000000001';
const SUGGESTER_UUID = '5a1f0000-0000-4000-8000-000000000002';
const OTHER_MEMBER_UUID = '5a1f0000-0000-4000-8000-000000000003';
const SUGGESTER_PHOTO_KEY = `listing-photos/${SUGGESTER_UUID}/0c0ffee0-0000-4000-8000-000000000001.jpg`;
const OTHER_MEMBER_PHOTO_KEY = `listing-photos/${OTHER_MEMBER_UUID}/0c0ffee0-0000-4000-8000-000000000002.jpg`;

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: LISTING_REF,
  slug: 'lux-cafe',
  ownerId: null,
  createdByStaffId: null,
  suggestedByUserId: 'suggester-1',
  status: ListingStatus.Review,
  path: 'suggest',
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
  photos: { wide: '', d1: '', d2: '', vibe: '' },
  alt: { wide: '', d1: '', d2: '', vibe: '' },
  rel: '',
  ownerName: '',
  ownerRole: '',
  ownerBio: '',
  visibility: '',
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

const renameDto = (name: string): AdminUpdateListingDto => ({ name });

describe('ListingsService.adminUpdate', () => {
  let service: ListingsService;
  let listings: { findOne: jest.Mock; save: jest.Mock };
  /** The repository the transaction hands out, which is where the locked
   *  read happens. */
  let lockedListings: { findOne: jest.Mock };
  let transactionManager: { save: jest.Mock; getRepository: jest.Mock };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let storage: { deleteObjectByReference: jest.Mock };
  /** Flipped once the transaction's work has resolved, standing in for the
   *  commit. */
  let isCommitted: boolean;
  /** `isCommitted` as it read at each bucket delete. */
  let commitStateAtEachDelete: boolean[];

  /** Every audit row written through the transaction. */
  const auditRows = (): Record<string, unknown>[] =>
    (transactionManager.save.mock.calls as [unknown, unknown?][])
      .filter(([target]) => target === ListingModerationEvent)
      .map(([, row]) => row as Record<string, unknown>);

  /** Every listing row written through the transaction. */
  const savedListings = (): Listing[] =>
    (transactionManager.save.mock.calls as [unknown, unknown?][])
      .filter(([target]) => target !== ListingModerationEvent)
      .map(([row]) => row as Listing);

  beforeEach(async () => {
    isCommitted = false;
    commitStateAtEachDelete = [];
    listings = {
      findOne: jest.fn(),
      save: jest.fn((value: Listing) => Promise.resolve(value)),
    };
    lockedListings = { findOne: jest.fn() };
    transactionManager = {
      // `manager.save(entity)` for the listing, and
      // `manager.save(ListingModerationEvent, row)` for its audit row.
      save: jest.fn((first: unknown, second?: unknown) =>
        Promise.resolve(second ?? first),
      ),
      getRepository: jest.fn(() => lockedListings),
    };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
      transaction: jest.fn(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          const result = await work(
            transactionManager as unknown as EntityManager,
          );
          isCommitted = true;
          return result;
        },
      ),
    };
    storage = {
      deleteObjectByReference: jest.fn(() => {
        commitStateAtEachDelete.push(isCommitted);
        return Promise.resolve();
      }),
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
        {
          provide: getRepositoryToken(ListingPublicQuestion),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            save: jest.fn((value: object) => Promise.resolve(value)),
            count: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: getRepositoryToken(ListingQuestion),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn().mockResolvedValue([]),
            save: jest.fn((value: object) => Promise.resolve(value)),
          },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: MessagingService, useValue: { deliverEnquiry: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: StorageService, useValue: storage },
        { provide: ReportsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: ListingCoManagersService,
          useValue: {
            isActiveCoManager: jest.fn().mockResolvedValue(false),
            listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ReviewReplyNotifier,
          useValue: { notifyReviewReplied: jest.fn() },
        },
        {
          provide: AdminQueueNotificationsService,
          useValue: { announce: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SafeSpaceVisitsService,
          useValue: { countIndependentVisits: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ListingsService);
    // The listing mapper resolves photo references through `toImageUrl`,
    // which needs a configured base.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('on a listing the platform holds', () => {
    it('saves the edit and writes one staff_edited row even while it is in review', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({ status: ListingStatus.Review }),
      );

      const result = await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      expect(savedListings()).toHaveLength(1);
      expect(savedListings()[0]?.name).toBe('Lux Café Arroios');
      expect(result.name).toBe('Lux Café Arroios');

      // The owner's rule skips an audit row on a listing nobody has seen yet.
      // A staff edit is recorded regardless, because nobody else can see
      // that an admin changed a page the platform holds.
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          listingId: 'listing-1',
          action: ListingModerationAction.StaffEdited,
          actorId: STAFF_ID,
          fromStatus: null,
          toStatus: null,
        }),
      );
      expect(rows[0]?.changedFields).toContain('name');
    });

    it('words the audit reason from the admin side', async () => {
      lockedListings.findOne.mockResolvedValue(baseListing());

      await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      // The listing has no owner and is still in review, so the owner's
      // "The owner edited this live listing" sentence would misstate both.
      const [row] = auditRows();
      expect(row?.reason).toContain('An admin edited this listing');
      expect(row?.reason).not.toContain('owner');
    });

    it('leaves detailsConfirmedAt as it was', async () => {
      const ownerConfirmedAt = new Date('2026-03-01T00:00:00.000Z');
      lockedListings.findOne.mockResolvedValue(
        baseListing({ detailsConfirmedAt: ownerConfirmedAt }),
      );

      await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      // The column records the owner vouching for the details. An admin
      // correcting a platform-held listing is a different act.
      expect(savedListings()[0]?.detailsConfirmedAt).toBe(ownerConfirmedAt);
    });

    it('leaves the moderation status where it was', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({ status: ListingStatus.Review }),
      );

      const result = await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      expect(savedListings()[0]?.status).toBe(ListingStatus.Review);
      expect(result.status).toBe(ListingStatus.Review);
    });

    it('reads the row under a pessimistic write lock inside the transaction', async () => {
      lockedListings.findOne.mockResolvedValue(baseListing());

      await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionManager.getRepository).toHaveBeenCalledWith(Listing);
      expect(lockedListings.findOne).toHaveBeenCalledWith({
        where: { ref: LISTING_REF },
        lock: { mode: 'pessimistic_write' },
      });
      // The unlocked repository is never the one the ownership check reads.
      expect(listings.findOne).not.toHaveBeenCalled();
    });

    it('deletes a replaced photo only after the edit has committed', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [{ image: OLD_PHOTO_KEY, alt: '', caption: '' }],
        }),
      );

      await service.adminUpdate(LISTING_REF, STAFF_ID, {
        photoGallery: [],
      });

      expect(storage.deleteObjectByReference).toHaveBeenCalledWith(
        OLD_PHOTO_KEY,
      );
      expect(commitStateAtEachDelete).toEqual([true]);
    });

    it('keeps every photo when the edit rolls back', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [{ image: OLD_PHOTO_KEY, alt: '', caption: '' }],
        }),
      );
      transactionManager.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.adminUpdate(LISTING_REF, STAFF_ID, {
          photoGallery: [],
        }),
      ).rejects.toThrow('write failed');
      expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
    });

    it('lets the admin re-save a photo the suggester uploaded', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [{ image: SUGGESTER_PHOTO_KEY, alt: '', caption: '' }],
        }),
      );

      await service.adminUpdate(LISTING_REF, STAFF_UUID, {
        name: 'Lux Café Arroios',
        photoGallery: [{ image: SUGGESTER_PHOTO_KEY, alt: 'The counter' }],
      });

      expect(savedListings()).toHaveLength(1);
    });

    it("refuses a new upload that belongs to somebody else's account", async () => {
      lockedListings.findOne.mockResolvedValue(baseListing());

      await expect(
        service.adminUpdate(LISTING_REF, STAFF_UUID, {
          photoGallery: [{ image: OTHER_MEMBER_PHOTO_KEY, alt: '' }],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(transactionManager.save).not.toHaveBeenCalled();
    });
  });

  describe('on a listing somebody owns', () => {
    it('answers 409 LISTING_HAS_OWNER and saves nothing', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({ ownerId: OWNER_ID }),
      );

      const failure: unknown = await service
        .adminUpdate(LISTING_REF, STAFF_ID, renameDto('Lux Café Arroios'))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toEqual(
        expect.objectContaining({
          message: 'This listing has an owner now, so its owner edits it.',
          code: 'LISTING_HAS_OWNER',
        }),
      );
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(listings.save).not.toHaveBeenCalled();
      expect(storage.deleteObjectByReference).not.toHaveBeenCalled();
    });
  });

  it('answers 404 for a ref that does not exist', async () => {
    lockedListings.findOne.mockResolvedValue(null);

    await expect(
      service.adminUpdate('QPL-2026-9999', STAFF_ID, renameDto('Anything')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transactionManager.save).not.toHaveBeenCalled();
  });

  describe('getEditableForStaff', () => {
    it('returns the listing the way a co-manager loads it', async () => {
      listings.findOne.mockResolvedValue(baseListing());

      const editable = await service.getEditableForStaff(LISTING_REF);

      expect(editable.ref).toBe(LISTING_REF);
      expect(editable.managementRole).toBe(ListingManagementRole.CoManager);
    });

    it('answers 404 for a ref that does not exist', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.getEditableForStaff('QPL-2026-9999'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('who owns the business (ownedBy)', () => {
    it('keeps it off the staff editor, which loads the co-manager shape', async () => {
      listings.findOne.mockResolvedValue(baseListing({ ownedBy: ['trans'] }));

      const editable = await service.getEditableForStaff(LISTING_REF);

      expect('ownedBy' in editable).toBe(false);
    });

    it('leaves a stored value alone on a staff edit', async () => {
      lockedListings.findOne.mockResolvedValue(
        baseListing({ ownedBy: ['women'] }),
      );

      await service.adminUpdate(
        LISTING_REF,
        STAFF_ID,
        renameDto('Lux Café Arroios'),
      );

      expect(savedListings()[0]?.ownedBy).toEqual(['women']);
    });

    it('records an owner edit to it on a live listing, and keeps the queer-owned verification', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: OWNER_ID,
          status: ListingStatus.Live,
          ownedBy: ['women'],
          queerOwnedVerified: true,
        }),
      );

      const result = await service.update(LISTING_REF, OWNER_ID, {
        ownedBy: ['trans', 'women'],
      });

      expect((result as unknown as Record<string, unknown>).ownedBy).toEqual([
        'women',
        'trans',
      ]);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.changedFields).toEqual(['ownedBy']);
      expect(rows[0]?.reason).toContain('who owns the business');
      // Self-declared, and separate from the identity a moderator confirmed.
      expect(savedListings()[0]?.queerOwnedVerified).toBe(true);
    });

    it('writes no audit row when the PATCH re-sends the stored set in another order', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          ownerId: OWNER_ID,
          status: ListingStatus.Live,
          ownedBy: ['women', 'nonbinary'],
        }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        ownedBy: ['nonbinary', 'women'],
      });

      expect(auditRows()).toHaveLength(0);
    });
  });

  // The owner's `update` now runs through the same edit core. Its audit rule
  // has to come out the other side unchanged.
  describe('the owner update it shares the edit core with', () => {
    it('writes no audit row for an owner edit on a listing in review', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: OWNER_ID, status: ListingStatus.Review }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        name: 'Lux Café Arroios',
      });

      expect(listings.save).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(auditRows()).toHaveLength(0);
    });

    it('writes owner_edited for an owner edit on a live listing', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({ ownerId: OWNER_ID, status: ListingStatus.Live }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        name: 'Lux Café Arroios',
      });

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          action: ListingModerationAction.OwnerEdited,
          actorId: OWNER_ID,
        }),
      );
      expect(rows[0]?.changedFields).toContain('name');
      expect(rows[0]?.reason).toContain('The owner edited this live listing');
      // The owner's real edit still confirms the details.
      expect(savedListings()[0]?.detailsConfirmedAt).toBeInstanceOf(Date);
    });
  });
});

describe('AdminListingsController staff editing routes', () => {
  const reflector = new Reflector();

  /** The route handler itself, read off the prototype by name. */
  const handlerOf = (
    methodName: keyof AdminListingsController,
  ): ((...args: never[]) => unknown) =>
    AdminListingsController.prototype[methodName];

  it.each(['getEditable', 'update'] as const)(
    '%s is narrowed to admin with an empty staff-role override',
    (methodName) => {
      const handler = handlerOf(methodName);

      expect(reflector.get<UserRole[]>(ROLES_KEY, handler)).toEqual([
        UserRole.Admin,
      ]);
      // The empty array overrides the class-level directory_moderator grant.
      expect(reflector.get<string[]>(STAFF_ROLES_KEY, handler)).toEqual([]);
    },
  );

  it('lets the edit re-send photos another account uploaded', () => {
    // The global interceptor would refuse the suggester's photos on every
    // staff save otherwise. `adminUpdate` pairs the exemption with the
    // service-side unchanged-value check the cases above pin.
    expect(allowsSharedUploads('AdminListingsController', 'update')).toBe(true);
  });

  it('declares the bare PATCH :ref after the bulk-status PATCH it could swallow', () => {
    // Nest matches handlers in declaration order, and property order on the
    // prototype is the order the decorators registered them.
    const declarationOrder = Object.getOwnPropertyNames(
      AdminListingsController.prototype,
    );
    const bulkStatusIndex = declarationOrder.indexOf('bulkSetStatus');
    const updateIndex = declarationOrder.indexOf('update');

    expect(bulkStatusIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(bulkStatusIndex);
  });
});

// The real global pipe (`whitelist: true, forbidNonWhitelisted: true`), the
// same way `listing-menu.dto.spec.ts` checks `CreateListingDto`. The omitted
// keys are enforced only here, so each one is sent on its own next to a body
// the pipe accepts.
describe('AdminUpdateListingDto through the real ValidationPipe', () => {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: AdminUpdateListingDto,
  };

  it('passes a business-only edit', async () => {
    const transformed = (await pipe.transform(
      { name: 'Lux Café Arroios' },
      metadata,
    )) as AdminUpdateListingDto;

    expect(transformed.name).toBe('Lux Café Arroios');
  });

  it.each([
    // `rel` is an owner-personal field the admin create body still carries,
    // so this DTO is the one that has to drop it.
    ['rel', 'owner'],
    ['ownerName', 'Ana Ribeiro'],
    ['ownerRole', 'Co-founder'],
    ['affirmingBaselineAccepted', true],
    ['publishState', 'live'],
    ['path', 'claim'],
  ])('answers 400 to a body carrying %s', async (key, value) => {
    await expect(
      pipe.transform({ name: 'Lux Café Arroios', [key]: value }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
