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
import { SafeSpaceVisitsService } from '../safe-space-vouches/safe-space-visits.service';
import { StorageService } from '../storage/storage.service';
import { ReviewReplyNotifier } from '../submissions/review-reply-notifier.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
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
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingsService } from './listings.service';

/**
 * The two history rows written outside `ListingsService.update`:
 * `suggestion_applied` when a moderator's accepted suggestion actually writes
 * a column, and `directory_paused` / `directory_resumed` when the owner or a
 * co-manager changes the listing's directory visibility. Each one lands in the
 * owner-facing history, so each is pinned to the moment something really
 * changed.
 */

const OWNER_ID = 'owner-1';
const CO_MANAGER_ID = 'co-manager-1';
const MODERATOR_ID = 'mod-1';

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  ownerId: OWNER_ID,
  createdByStaffId: null,
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

describe('listing history write paths', () => {
  describe('suggestion_applied (ListingEditSuggestionsService.resolve)', () => {
    let service: ListingEditSuggestionsService;
    let listings: {
      findOne: jest.Mock;
      save: jest.Mock;
      manager: { transaction: jest.Mock };
    };
    let moderationEvents: { save: jest.Mock };
    let transactionalListings: { save: jest.Mock };
    let transactionalModerationEvents: { save: jest.Mock };
    let suggestions: { findOne: jest.Mock; save: jest.Mock };

    const pendingSuggestion = (
      overrides: Partial<ListingEditSuggestion> = {},
    ): Partial<ListingEditSuggestion> => ({
      id: 'suggestion-1',
      listingId: 'listing-1',
      field: 'phone',
      message: 'The phone number changed.',
      proposedValue: '+351 912 345 678',
      status: ListingEditSuggestionStatus.Pending,
      resolvedAt: null,
      resolvedByUserId: null,
      ...overrides,
    });

    beforeEach(async () => {
      transactionalListings = {
        save: jest.fn((listing: Listing) => Promise.resolve(listing)),
      };
      transactionalModerationEvents = {
        save: jest.fn((event: object) => Promise.resolve(event)),
      };
      moderationEvents = {
        save: jest.fn((event: object) => Promise.resolve(event)),
      };
      listings = {
        findOne: jest.fn().mockResolvedValue(baseListing()),
        save: jest.fn((listing: Listing) => Promise.resolve(listing)),
        // The stub runs the callback with a manager whose `withRepository`
        // hands back a separate transaction-bound mock for each repository, so
        // a write that skips the transaction lands on the plain mock instead
        // and the assertions below catch it.
        manager: {
          transaction: jest.fn(
            (work: (manager: { withRepository: jest.Mock }) => Promise<void>) =>
              work({
                withRepository: jest.fn((repository: unknown) =>
                  repository === listings
                    ? transactionalListings
                    : repository === moderationEvents
                      ? transactionalModerationEvents
                      : repository,
                ),
              }),
          ),
        },
      };
      suggestions = {
        findOne: jest.fn(),
        save: jest.fn((row: object) => Promise.resolve(row)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ListingEditSuggestionsService,
          { provide: getRepositoryToken(Listing), useValue: listings },
          {
            provide: getRepositoryToken(ListingEditSuggestion),
            useValue: suggestions,
          },
          {
            provide: getRepositoryToken(Profile),
            useValue: { find: jest.fn().mockResolvedValue([]) },
          },
          {
            provide: getRepositoryToken(ListingModerationEvent),
            useValue: moderationEvents,
          },
          {
            provide: NotificationsService,
            useValue: { create: jest.fn().mockResolvedValue(undefined) },
          },
          {
            provide: AdminQueueNotificationsService,
            useValue: { announce: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }).compile();
      service = module.get(ListingEditSuggestionsService);
    });

    it('records an applied phone correction as a moderator change to social, naming the field without the value', async () => {
      suggestions.findOne.mockResolvedValue(pendingSuggestion());

      await service.resolve('suggestion-1', MODERATOR_ID, {
        status: 'accepted',
      });

      expect(listings.manager.transaction).toHaveBeenCalledTimes(1);
      // Both writes ride the transaction: nothing reaches the plain mocks.
      expect(listings.save).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
      expect(transactionalListings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          social: expect.objectContaining({
            phone: '+351 912 345 678',
          }) as Listing['social'],
        }),
      );
      expect(transactionalModerationEvents.save).toHaveBeenCalledTimes(1);
      expect(transactionalModerationEvents.save).toHaveBeenCalledWith({
        listingId: 'listing-1',
        actorId: MODERATOR_ID,
        action: ListingModerationAction.SuggestionApplied,
        fromStatus: null,
        toStatus: null,
        reason:
          'A moderator applied a suggested correction to the phone number.',
        changedFields: ['social'],
      });
      const [savedEvent] = transactionalModerationEvents.save.mock.calls[0] as [
        { reason: string },
      ];
      expect(savedEvent.reason).not.toContain('912');
    });

    it('writes no history row when the accepted value fails validation and the listing stays as it was', async () => {
      suggestions.findOne.mockResolvedValue(
        pendingSuggestion({
          field: 'website',
          message: 'Their site moved.',
          proposedValue: 'javascript:alert(1)',
        }),
      );

      await service.resolve('suggestion-1', MODERATOR_ID, {
        status: 'accepted',
      });

      expect(listings.save).not.toHaveBeenCalled();
      expect(listings.manager.transaction).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
    });

    it('writes no history row for an accepted "other" suggestion, which has no column to write', async () => {
      suggestions.findOne.mockResolvedValue(
        pendingSuggestion({
          field: 'other',
          message: 'The whole page is out of date.',
          proposedValue: null,
        }),
      );

      await service.resolve('suggestion-1', MODERATOR_ID, {
        status: 'accepted',
      });

      expect(listings.save).not.toHaveBeenCalled();
      expect(listings.manager.transaction).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
    });
  });

  describe('directory_paused / directory_resumed (ListingsService.setDirectoryVisibility)', () => {
    let service: ListingsService;
    let listings: { findOne: jest.Mock; save: jest.Mock };
    let coManagers: {
      isActiveCoManager: jest.Mock;
      listingIdsCoManagedBy: jest.Mock;
    };
    let transactionManager: { save: jest.Mock };
    let dataSource: { query: jest.Mock; transaction: jest.Mock };

    beforeEach(async () => {
      listings = {
        findOne: jest.fn(),
        save: jest.fn((listing: Listing) => Promise.resolve(listing)),
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
      };
      dataSource = {
        query: jest.fn().mockResolvedValue([{ seq: '1' }]),
        transaction: jest.fn(
          (work: (manager: EntityManager) => Promise<unknown>) =>
            work(transactionManager as unknown as EntityManager),
        ),
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
              save: jest.fn((event: object) => Promise.resolve(event)),
              find: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: getRepositoryToken(ListingQuestion),
            useValue: { findOne: jest.fn(), find: jest.fn(), save: jest.fn() },
          },
          {
            provide: getRepositoryToken(ListingPublicQuestion),
            useValue: { findOne: jest.fn(), find: jest.fn(), save: jest.fn() },
          },
          { provide: DataSource, useValue: dataSource },
          {
            provide: MessagingService,
            useValue: { deliverEnquiry: jest.fn() },
          },
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
      setImageUrlBase('https://api.test');
    });

    afterEach(() => {
      resetImageUrlBaseForTesting();
    });

    it('records a pause with the calling co-manager as the actor', async () => {
      const listing = baseListing();
      listings.findOne.mockResolvedValue(listing);
      coManagers.isActiveCoManager.mockResolvedValue(true);

      await service.setDirectoryVisibility('QPL-2026-0001', CO_MANAGER_ID, {
        isHiddenByOwner: true,
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionManager.save).toHaveBeenCalledWith(
        expect.objectContaining({ isHiddenByOwner: true }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        {
          listingId: 'listing-1',
          actorId: CO_MANAGER_ID,
          action: ListingModerationAction.DirectoryPaused,
          fromStatus: null,
          toStatus: null,
          reason: null,
          changedFields: null,
        },
      );
    });

    it('records a resume with the calling owner as the actor', async () => {
      const listing = baseListing({
        isHiddenByOwner: true,
        ownerHiddenAt: new Date('2026-03-04T00:00:00.000Z'),
      });
      listings.findOne.mockResolvedValue(listing);

      await service.setDirectoryVisibility('QPL-2026-0001', OWNER_ID, {
        isHiddenByOwner: false,
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(transactionManager.save).toHaveBeenCalledWith(
        ListingModerationEvent,
        {
          listingId: 'listing-1',
          actorId: OWNER_ID,
          action: ListingModerationAction.DirectoryResumed,
          fromStatus: null,
          toStatus: null,
          reason: null,
          changedFields: null,
        },
      );
    });

    it('writes nothing when the request repeats the current visibility', async () => {
      const listing = baseListing({
        isHiddenByOwner: true,
        ownerHiddenAt: new Date('2026-03-04T00:00:00.000Z'),
      });
      listings.findOne.mockResolvedValue(listing);

      await service.setDirectoryVisibility('QPL-2026-0001', OWNER_ID, {
        isHiddenByOwner: true,
      });

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
      expect(listings.save).not.toHaveBeenCalled();
    });
  });
});
