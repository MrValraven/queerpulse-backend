import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
  toImageUrl,
} from '../common/image-url';
import { MediaCropService } from '../media-crops/media-crops.service';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { StorageService } from '../storage/storage.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { Profile } from '../users/entities/profile.entity';
import { UpdateListingPhotoFramingDto } from './dto/update-listing-photo-framing.dto';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
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
import { emptyListingMobileDetails } from './listing-mobile-details';
import { emptyListingOnlineDetails } from './listing-online-details';
import {
  ListingGalleryPhoto,
  ListingPhotoFraming,
} from './listing-photo-gallery';
import { ListingsService } from './listings.service';

/**
 * REPOSITIONING A LISTING'S PHOTOS.
 *
 * The team (owner or active co-manager) and the admins can save where each
 * gallery photo sits inside its frame. The save touches the gallery column
 * alone, with one targeted update and one history row, and only on a listing
 * the directory shows. A photo is named by the image the read side sent, so a
 * resolved `/files/<key>` URL has to land on the stored key. The listing
 * editor's own save carries the framing forward for every photo that stays,
 * which is tested at the bottom, since the editor never sends framing itself.
 */

const OWNER_ID = 'owner-1';
const CO_MANAGER_ID = 'co-manager-1';
const STRANGER_ID = 'stranger-1';
const STAFF_ID = 'staff-1';
const LISTING_REF = 'QPL-2026-0001';
// Well-formed storage keys, so `storageKeyFromImageUrl` and the foreign-upload
// rule both read them as our own uploads.
const FRONT_KEY =
  'listing-photos/5a1f0000-0000-4000-8000-00000000000a/0c0ffee0-0000-4000-8000-00000000000a.webp';
const BAR_KEY =
  'listing-photos/5a1f0000-0000-4000-8000-00000000000b/0c0ffee0-0000-4000-8000-00000000000b.webp';
const ABSENT_KEY =
  'listing-photos/5a1f0000-0000-4000-8000-00000000000c/0c0ffee0-0000-4000-8000-00000000000c.webp';
const TERRACE_URL = 'https://cdn.example.com/terrace.jpg';
const SAVED_FRAMING: ListingPhotoFraming = {
  focusX: 0.25,
  focusY: 0.75,
  zoom: 2,
};
const TERRACE_FRAMING: ListingPhotoFraming = {
  focusX: 0.6,
  focusY: 0.4,
  zoom: 1.5,
};
const CENTRED_FRAMING: ListingPhotoFraming = {
  focusX: 0.5,
  focusY: 0.5,
  zoom: 1,
};

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: LISTING_REF,
  slug: 'lux-cafe',
  ownerId: OWNER_ID,
  createdByStaffId: null,
  suggestedByUserId: 'suggester-1',
  status: ListingStatus.Live,
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
  attributes: [],
  highlights: [],
  entryMode: null,
  coverPolicy: null,
  coverFreeBefore: null,
  payments: [],
  issuesNifInvoices: null,
  inclusionPractices: [],
  saferSpacePolicyUrl: null,
  langsOther: '',
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
  coverPhoto: null,
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

/** One gallery entry, with the framing key present only when one is given. */
const galleryPhoto = (
  image: string,
  framing?: ListingPhotoFraming,
): ListingGalleryPhoto => ({
  image,
  alt: `A photo of ${image}`,
  caption: '',
  ...(framing ? { framing } : {}),
});

/** A live listing holding the front photo (unframed unless given one) and the
 *  external terrace photo. */
const listingWithGallery = (
  frontFraming?: ListingPhotoFraming,
  overrides: Partial<Listing> = {},
): Listing =>
  baseListing({
    photoGallery: [
      galleryPhoto(FRONT_KEY, frontFraming),
      galleryPhoto(TERRACE_URL),
    ],
    ...overrides,
  });

const framingBody = (
  ...photos: { image: string; framing: ListingPhotoFraming }[]
): UpdateListingPhotoFramingDto => ({ photos });

/** The rejection a call ends in, so its status, code and message can be read. */
const failureOf = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending;
  } catch (failure) {
    return failure;
  }
  throw new Error('Expected the call to be refused, and it resolved.');
};

const reasonCodeOf = (failure: unknown): unknown =>
  ((failure as HttpException).getResponse() as { code?: unknown }).code;

describe('listing photo framing', () => {
  let service: ListingsService;
  let listings: { findOne: jest.Mock; save: jest.Mock };
  /** The repository the transaction hands out, which is where the locked
   *  read happens. */
  let lockedListings: { findOne: jest.Mock };
  let transactionManager: {
    save: jest.Mock;
    update: jest.Mock;
    getRepository: jest.Mock;
  };
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let coManagers: {
    isActiveCoManager: jest.Mock;
    listingIdsCoManagedBy: jest.Mock;
  };

  /** Every audit row written through the transaction. */
  const auditRows = (): Record<string, unknown>[] =>
    (transactionManager.save.mock.calls as [unknown, unknown?][])
      .filter(([target]) => target === ListingModerationEvent)
      .map(([, row]) => row as Record<string, unknown>);

  /** The column values of every targeted update, in call order. */
  const galleryWrites = (): Record<string, unknown>[] =>
    (transactionManager.update.mock.calls as [unknown, unknown, unknown][]).map(
      ([, , columnValues]) => columnValues as Record<string, unknown>,
    );

  /** The gallery the first targeted update wrote. */
  const writtenGallery = (): ListingGalleryPhoto[] =>
    (galleryWrites()[0]?.photoGallery ?? []) as ListingGalleryPhoto[];

  /** Serves one stored row to both reads a save can make: the unlocked read
   *  the member route's access check runs before the transaction, and the
   *  locked read inside it. */
  const storeListing = (listing: Listing | null): void => {
    listings.findOne.mockResolvedValue(listing);
    lockedListings.findOne.mockResolvedValue(listing);
  };

  /** Every listing read, on either repository, that asked for a row lock. */
  const lockedReads = (): unknown[] =>
    [
      ...(listings.findOne.mock.calls as unknown[][]),
      ...(lockedListings.findOne.mock.calls as unknown[][]),
    ]
      .map(([options]) => options)
      .filter(
        (options) =>
          (options as { lock?: unknown } | undefined)?.lock !== undefined,
      );

  beforeEach(async () => {
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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      getRepository: jest.fn(() => lockedListings),
    };
    dataSource = {
      query: jest.fn().mockResolvedValue([{ seq: '1' }]),
      transaction: jest.fn(
        async (work: (manager: EntityManager) => Promise<unknown>) =>
          work(transactionManager as unknown as EntityManager),
      ),
    };
    coManagers = {
      isActiveCoManager: jest.fn().mockResolvedValue(false),
      listingIdsCoManagedBy: jest.fn().mockResolvedValue([]),
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
        {
          provide: StorageService,
          useValue: {
            deleteObjectByReference: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ReportsService, useValue: { create: jest.fn() } },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: ListingCoManagersService, useValue: coManagers },
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
    // The body names photos by their resolved `/files/<key>` URL, and the
    // response resolves keys again, so both directions need a configured base.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('ListingsService.updatePhotoFraming', () => {
    it('saves the owner framing with one targeted update and one owner_edited row', async () => {
      storeListing(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(transactionManager.update).toHaveBeenCalledTimes(1);
      expect(transactionManager.update).toHaveBeenCalledWith(
        Listing,
        { id: 'listing-1' },
        { photoGallery: expect.any(Array) as unknown },
      );
      expect(Object.keys(galleryWrites()[0] ?? {})).toEqual(['photoGallery']);
      expect(writtenGallery()[0]?.framing).toEqual(SAVED_FRAMING);

      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        listingId: 'listing-1',
        actorId: OWNER_ID,
        action: ListingModerationAction.OwnerEdited,
        fromStatus: null,
        toStatus: null,
        changedFields: ['photoFraming'],
      });
      expect(rows[0]?.reason).toContain('changed the photo positions');
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('lets an active co-manager save and records them as the actor', async () => {
      storeListing(listingWithGallery());
      coManagers.isActiveCoManager.mockResolvedValue(true);

      await service.updatePhotoFraming(
        LISTING_REF,
        CO_MANAGER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(coManagers.isActiveCoManager).toHaveBeenCalledWith(
        'listing-1',
        CO_MANAGER_ID,
      );
      expect(transactionManager.update).toHaveBeenCalledTimes(1);
      expect(auditRows()[0]).toMatchObject({
        actorId: CO_MANAGER_ID,
        action: ListingModerationAction.OwnerEdited,
      });
    });

    it('never pays for a seat lookup when the caller is the owner', async () => {
      storeListing(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(coManagers.isActiveCoManager).not.toHaveBeenCalled();
    });

    it('locks the listing row while it reads the gallery', async () => {
      // The unlocked row the access check reads holds an empty gallery, so the
      // save only finds the front photo if it reads the gallery under the lock.
      listings.findOne.mockResolvedValue(baseListing({ photoGallery: [] }));
      lockedListings.findOne.mockResolvedValue(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(lockedListings.findOne).toHaveBeenCalledWith({
        where: { ref: LISTING_REF },
        lock: { mode: 'pessimistic_write' },
      });
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { ref: LISTING_REF },
      });
      expect(writtenGallery()[0]?.framing).toEqual(SAVED_FRAMING);
    });

    it('runs the seat lookup before the transaction opens', async () => {
      storeListing(listingWithGallery());
      let isTransactionOpen = false;
      const seatLookupsInsideTransaction: boolean[] = [];
      dataSource.transaction.mockImplementation(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          isTransactionOpen = true;
          try {
            return await work(transactionManager as unknown as EntityManager);
          } finally {
            isTransactionOpen = false;
          }
        },
      );
      coManagers.isActiveCoManager.mockImplementation(() => {
        seatLookupsInsideTransaction.push(isTransactionOpen);
        return Promise.resolve(true);
      });

      await service.updatePhotoFraming(
        LISTING_REF,
        CO_MANAGER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(seatLookupsInsideTransaction).toEqual([false]);
      expect(transactionManager.update).toHaveBeenCalledTimes(1);
    });

    it('matches a photo sent as its resolved /files URL against the stored key', async () => {
      storeListing(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({
          image: `https://api.test/files/${FRONT_KEY}`,
          framing: SAVED_FRAMING,
        }),
      );

      expect(writtenGallery()[0]).toMatchObject({
        image: FRONT_KEY,
        framing: SAVED_FRAMING,
      });
      expect(writtenGallery()[1]).not.toHaveProperty('framing');
    });

    it('matches an external https photo by its URL', async () => {
      storeListing(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: TERRACE_URL, framing: TERRACE_FRAMING }),
      );

      expect(writtenGallery()[1]).toMatchObject({
        image: TERRACE_URL,
        framing: TERRACE_FRAMING,
      });
      expect(writtenGallery()[0]).not.toHaveProperty('framing');
    });

    it('keeps the framing of photos the body leaves out', async () => {
      storeListing(
        baseListing({
          photoGallery: [
            galleryPhoto(FRONT_KEY),
            galleryPhoto(TERRACE_URL, TERRACE_FRAMING),
          ],
        }),
      );

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(writtenGallery()[0]?.framing).toEqual(SAVED_FRAMING);
      expect(writtenGallery()[1]?.framing).toEqual(TERRACE_FRAMING);
    });

    it('returns the whole gallery view with framing', async () => {
      storeListing(listingWithGallery());

      const result = await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(result.photoGallery).toHaveLength(2);
      expect(result.photoGallery[0]).toMatchObject({
        image: toImageUrl(FRONT_KEY),
        framing: SAVED_FRAMING,
      });
      expect(result.photoGallery[1]).toMatchObject({ image: TERRACE_URL });
    });

    it('writes nothing when the body repeats the stored framing in another key order', async () => {
      // jsonb hands objects back with its own key order, which is what this
      // stored framing imitates.
      storeListing(listingWithGallery({ zoom: 2, focusX: 0.25, focusY: 0.75 }));

      const result = await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([]);
      expect(result.photoGallery[0]?.framing).toEqual(SAVED_FRAMING);
    });

    it('counts a reset to the centre at zoom 1 as a change and removes the key', async () => {
      storeListing(listingWithGallery(SAVED_FRAMING));

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: CENTRED_FRAMING }),
      );

      expect(transactionManager.update).toHaveBeenCalledTimes(1);
      expect(writtenGallery()[0]).not.toHaveProperty('framing');
      expect(auditRows()).toHaveLength(1);
    });

    it('writes nothing for a reset on a photo that never had framing', async () => {
      storeListing(listingWithGallery());

      await service.updatePhotoFraming(
        LISTING_REF,
        OWNER_ID,
        framingBody({ image: FRONT_KEY, framing: CENTRED_FRAMING }),
      );

      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([]);
    });

    it('refuses a photo missing from the gallery with PHOTO_NOT_IN_GALLERY and writes nothing', async () => {
      storeListing(listingWithGallery());

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          OWNER_ID,
          framingBody(
            { image: FRONT_KEY, framing: SAVED_FRAMING },
            { image: ABSENT_KEY, framing: TERRACE_FRAMING },
          ),
        ),
      );

      expect(failure).toBeInstanceOf(BadRequestException);
      expect(reasonCodeOf(failure)).toBe('PHOTO_NOT_IN_GALLERY');
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    // `@IsImageReference()` lets both of these through the validation pipe.
    it.each([
      ['a null image', null],
      ['an empty image', ''],
    ])(
      'refuses %s with PHOTO_NOT_IN_GALLERY and writes nothing',
      async (_label, image) => {
        storeListing(listingWithGallery());

        const failure = await failureOf(
          service.updatePhotoFraming(
            LISTING_REF,
            OWNER_ID,
            framingBody({
              image: image as unknown as string,
              framing: SAVED_FRAMING,
            }),
          ),
        );

        expect(failure).toBeInstanceOf(BadRequestException);
        expect(reasonCodeOf(failure)).toBe('PHOTO_NOT_IN_GALLERY');
        expect(transactionManager.update).not.toHaveBeenCalled();
        expect(transactionManager.save).not.toHaveBeenCalled();
      },
    );

    it('answers 404 LISTING_NOT_FOUND for an unknown ref', async () => {
      storeListing(null);

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          OWNER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(NotFoundException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_FOUND');
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers 404 LISTING_NOT_FOUND when the listing is removed before the lock', async () => {
      listings.findOne.mockResolvedValue(listingWithGallery());
      lockedListings.findOne.mockResolvedValue(null);

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          OWNER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(NotFoundException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_FOUND');
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    it('refuses a member outside the team without taking the row lock', async () => {
      storeListing(listingWithGallery());

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          STRANGER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(ForbiddenException);
      expect(lockedReads()).toEqual([]);
      expect(lockedListings.findOne).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers 403 LISTING_NOT_MANAGER to a member outside the team on a live listing', async () => {
      storeListing(listingWithGallery());

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          STRANGER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(ForbiddenException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_MANAGER');
      expect(transactionManager.update).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    it.each([
      ['in review', { status: ListingStatus.Review }],
      ['paused', { isHiddenByOwner: true }],
    ])(
      'answers 404 LISTING_NOT_FOUND to a member outside the team when the listing is %s',
      async (_label, overrides: Partial<Listing>) => {
        storeListing(listingWithGallery(undefined, overrides));

        const failure = await failureOf(
          service.updatePhotoFraming(
            LISTING_REF,
            STRANGER_ID,
            framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
          ),
        );

        expect(failure).toBeInstanceOf(NotFoundException);
        expect(reasonCodeOf(failure)).toBe('LISTING_NOT_FOUND');
        expect(transactionManager.update).not.toHaveBeenCalled();
        expect(lockedReads()).toEqual([]);
      },
    );

    it('answers 409 LISTING_NOT_LIVE to the owner of a listing in review', async () => {
      storeListing(
        listingWithGallery(undefined, { status: ListingStatus.Review }),
      );

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          OWNER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(ConflictException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_LIVE');
      expect((failure as HttpException).message).toContain('not live');
      expect(transactionManager.update).not.toHaveBeenCalled();
    });

    it('answers 409 LISTING_NOT_LIVE to the owner of a paused listing', async () => {
      storeListing(listingWithGallery(undefined, { isHiddenByOwner: true }));

      const failure = await failureOf(
        service.updatePhotoFraming(
          LISTING_REF,
          OWNER_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(ConflictException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_LIVE');
      expect((failure as HttpException).message).toContain('paused');
      expect(transactionManager.update).not.toHaveBeenCalled();
    });
  });

  describe('ListingsService.adminUpdatePhotoFraming', () => {
    it('repositions photos on a listing somebody owns', async () => {
      storeListing(listingWithGallery(undefined, { ownerId: OWNER_ID }));

      await service.adminUpdatePhotoFraming(
        LISTING_REF,
        STAFF_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(transactionManager.update).toHaveBeenCalledTimes(1);
      expect(writtenGallery()[0]?.framing).toEqual(SAVED_FRAMING);
      const rows = auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: ListingModerationAction.StaffEdited,
        actorId: STAFF_ID,
        changedFields: ['photoFraming'],
      });
      expect(rows[0]?.reason).toContain(
        'An admin edited this listing and changed the photo positions',
      );
    });

    it('repositions photos on a listing the platform holds', async () => {
      storeListing(listingWithGallery(undefined, { ownerId: null }));

      await service.adminUpdatePhotoFraming(
        LISTING_REF,
        STAFF_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(transactionManager.update).toHaveBeenCalledTimes(1);
      expect(auditRows()[0]).toMatchObject({
        action: ListingModerationAction.StaffEdited,
        actorId: STAFF_ID,
      });
    });

    it('never consults the co-manager seats', async () => {
      storeListing(listingWithGallery());

      await service.adminUpdatePhotoFraming(
        LISTING_REF,
        STAFF_ID,
        framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
      );

      expect(coManagers.isActiveCoManager).not.toHaveBeenCalled();
    });

    it('answers 409 LISTING_NOT_LIVE on a listing in review', async () => {
      storeListing(
        listingWithGallery(undefined, { status: ListingStatus.Review }),
      );

      const failure = await failureOf(
        service.adminUpdatePhotoFraming(
          LISTING_REF,
          STAFF_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(ConflictException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_LIVE');
      expect(transactionManager.update).not.toHaveBeenCalled();
    });

    it('answers 404 LISTING_NOT_FOUND for an unknown ref', async () => {
      storeListing(null);

      const failure = await failureOf(
        service.adminUpdatePhotoFraming(
          LISTING_REF,
          STAFF_ID,
          framingBody({ image: FRONT_KEY, framing: SAVED_FRAMING }),
        ),
      );

      expect(failure).toBeInstanceOf(NotFoundException);
      expect(reasonCodeOf(failure)).toBe('LISTING_NOT_FOUND');
    });
  });

  describe('the editor save keeps framing (ListingsService.update)', () => {
    /** The listing the editor save wrote last, whichever path saved it: the
     *  repository when nothing moved, the transaction when a field did. */
    const editorSavedListing = (): Listing | undefined => {
      const repositorySaves = (listings.save.mock.calls as [Listing][]).map(
        ([row]) => row,
      );
      const transactionSaves = (
        transactionManager.save.mock.calls as [unknown, unknown?][]
      )
        .filter(([target]) => target !== ListingModerationEvent)
        .map(([row]) => row as Listing);
      return [...repositorySaves, ...transactionSaves].at(-1);
    };

    it('keeps framing through a legacy photos and alt save that leaves the photo in its slot', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [
            {
              image: FRONT_KEY,
              alt: 'Front',
              caption: '',
              framing: SAVED_FRAMING,
            },
          ],
        }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        photos: { wide: FRONT_KEY },
        alt: { wide: 'Front' },
      });

      const saved = editorSavedListing();
      expect(saved?.photoGallery[0]?.framing).toEqual(SAVED_FRAMING);
      // Nothing moved, so the save wrote no history and vouched for nothing.
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(saved?.detailsConfirmedAt).toBeNull();
    });

    it('drops framing for a photo the editor replaced', async () => {
      // The bar photo is the listing's cover, so it is already the listing's
      // own and the foreign-upload rule lets the editor move it into a slot.
      listings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [
            {
              image: FRONT_KEY,
              alt: 'Front',
              caption: '',
              framing: SAVED_FRAMING,
            },
          ],
          coverPhoto: { image: BAR_KEY, alt: 'The bar' },
        }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        photos: { wide: BAR_KEY },
      });

      const saved = editorSavedListing();
      expect(saved?.photoGallery[0]?.image).toBe(BAR_KEY);
      expect(saved?.photoGallery[0]).not.toHaveProperty('framing');
    });

    it('keeps framing through a photoGallery save that re-sends the same photos', async () => {
      listings.findOne.mockResolvedValue(
        baseListing({
          photoGallery: [
            {
              image: FRONT_KEY,
              alt: 'Front',
              caption: '',
              framing: SAVED_FRAMING,
            },
            galleryPhoto(TERRACE_URL, TERRACE_FRAMING),
          ],
        }),
      );

      await service.update(LISTING_REF, OWNER_ID, {
        photoGallery: [
          { image: FRONT_KEY, alt: 'Front', caption: '' },
          { image: TERRACE_URL, alt: `A photo of ${TERRACE_URL}`, caption: '' },
        ],
      });

      const saved = editorSavedListing();
      expect(saved?.photoGallery[0]?.framing).toEqual(SAVED_FRAMING);
      expect(saved?.photoGallery[1]?.framing).toEqual(TERRACE_FRAMING);
      expect(transactionManager.save).not.toHaveBeenCalled();
    });
  });
});
