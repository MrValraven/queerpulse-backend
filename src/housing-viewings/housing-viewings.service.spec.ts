import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, MoreThanOrEqual } from 'typeorm';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationService } from '../verification/verification.service';
import {
  HousingViewing,
  HousingViewingMode,
  HousingViewingParty,
  HousingViewingStatus,
} from './entities/housing-viewing.entity';
import { HousingViewingsService } from './housing-viewings.service';

/**
 * The viewing rules that decide who may reach whom and who sees the exact
 * address:
 *
 *  1. BLOCKS ON REQUEST (ENG-468): a block either way refuses a viewing
 *     request with the enquiry path's 403, before the pledge or the step-up.
 *  2. BOOKABLE HOMES ONLY (ENG-471): a filled, expired or taken-down home 404s
 *     a request, and accepting on one answers 400.
 *  3. CANCELLING AN ACCEPTED VIEWING (ENG-467): either participant may call it
 *     off until it is completed, and the other side gets the cancelled bell.
 *  4. THE UNLOCK RULE (ENG-467): a block either way closes the address, and
 *     once a home is relisted only viewings from the current letting count.
 *  5. CLOSING A HOME'S OPEN VIEWINGS (ENG-466): filling or deleting a home
 *     cancels its requested and accepted viewings and tells each requester
 *     whose viewing the update changed.
 *  6. THE LISTING FLAGS: each viewing says whether its home can still be
 *     booked from the caller's side and whether the lister deleted it.
 */
describe('HousingViewingsService', () => {
  let service: HousingViewingsService;
  let viewings: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let updateBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let listings: { findOne: jest.Mock; find: jest.Mock };
  let profiles: { find: jest.Mock };
  let verification: { requireLevel: jest.Mock };
  let affirmingPledge: { requireAccepted: jest.Mock };
  let notifications: { create: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock; blockedUserIds: jest.Mock };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };

  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const HOUR_MS = 60 * 60 * 1000;

  const liveListing = (overrides: Partial<HousingListing> = {}) =>
    ({
      id: 'listing-1',
      ref: 'HL-0001',
      slug: 'benfica-room',
      title: 'Sunny room in Benfica',
      ownerId: 'lister-1',
      status: HousingListingStatus.Live,
      filledAt: null,
      expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR_MS),
      relistedAt: null,
      deletedAt: null,
      ...overrides,
    }) as HousingListing;

  const viewing = (overrides: Partial<HousingViewing> = {}) => ({
    id: 'viewing-1',
    listingId: 'listing-1',
    requesterId: 'guest-1',
    listerId: 'lister-1',
    mode: HousingViewingMode.InPerson,
    status: HousingViewingStatus.Requested,
    proposedBy: HousingViewingParty.Requester,
    proposedSlots: [new Date(NOW.getTime() + 48 * HOUR_MS)],
    acceptedSlot: null,
    note: '',
    responseNote: null,
    createdAt: new Date(NOW.getTime() - HOUR_MS),
    updatedAt: new Date(NOW.getTime() - HOUR_MS),
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);

    updateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [], affected: 0 }),
    };
    for (const step of [
      updateBuilder.update,
      updateBuilder.set,
      updateBuilder.where,
      updateBuilder.andWhere,
      updateBuilder.returning,
    ]) {
      step.mockReturnValue(updateBuilder);
    }
    viewings = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((row: object) =>
        Promise.resolve({
          id: 'viewing-new',
          createdAt: NOW,
          updatedAt: NOW,
          ...row,
        }),
      ),
      create: jest.fn((row: object) => row),
      exists: jest.fn().mockResolvedValue(false),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => updateBuilder),
    };
    listings = {
      findOne: jest.fn().mockResolvedValue(liveListing()),
      find: jest.fn().mockResolvedValue([liveListing()]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    verification = { requireLevel: jest.fn().mockResolvedValue(undefined) };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HousingViewingsService,
        { provide: getRepositoryToken(HousingViewing), useValue: viewings },
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: VerificationService, useValue: verification },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
        { provide: NotificationsService, useValue: notifications },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();

    service = moduleRef.get(HousingViewingsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const requestDto = {
    listingRef: 'HL-0001',
    mode: HousingViewingMode.InPerson,
    proposedSlots: [new Date(NOW.getTime() + 48 * HOUR_MS).toISOString()],
  };

  // -------------------------------------------------------------------------
  // 1. Blocks on request
  // -------------------------------------------------------------------------
  describe('request', () => {
    it('refuses a blocked pair with the enquiry path 403 before the pledge and step-up', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      await expect(service.request('guest-1', requestDto)).rejects.toThrow(
        new ForbiddenException('You cannot contact this member'),
      );
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'guest-1',
        'lister-1',
      );
      expect(affirmingPledge.requireAccepted).not.toHaveBeenCalled();
      expect(verification.requireLevel).not.toHaveBeenCalled();
      expect(viewings.save).not.toHaveBeenCalled();
    });

    it('files the request and tells the lister when the pair is clear', async () => {
      const view = await service.request('guest-1', requestDto);

      expect(view.status).toBe(HousingViewingStatus.Requested);
      expect(view.canCancel).toBe(true);
      expect(view.canComplete).toBe(false);
      expect(notifications.create).toHaveBeenCalledWith(
        'lister-1',
        NotificationType.HousingViewingRequested,
        expect.objectContaining({ slug: 'benfica-room' }),
        'guest-1',
      );
    });

    // ---------------------------------------------------------------------
    // 2. Bookable homes only
    // ---------------------------------------------------------------------
    it('404s a filled home', async () => {
      listings.findOne.mockResolvedValue(
        liveListing({ filledAt: new Date(NOW.getTime() - HOUR_MS) }),
      );

      await expect(
        service.request('guest-1', requestDto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(viewings.save).not.toHaveBeenCalled();
    });

    it('404s an expired home', async () => {
      listings.findOne.mockResolvedValue(
        liveListing({ expiresAt: new Date(NOW.getTime() - HOUR_MS) }),
      );

      await expect(
        service.request('guest-1', requestDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a home a moderator took down', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.request('guest-1', requestDto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'housing',
        'benfica-room',
      );
    });
  });

  describe('accept', () => {
    const acceptDto = {
      slot: new Date(NOW.getTime() + 48 * HOUR_MS).toISOString(),
    };

    it('answers 400 when the home has been filled since the request', async () => {
      viewings.findOne.mockResolvedValue(viewing());
      listings.findOne.mockResolvedValue(
        liveListing({ filledAt: new Date(NOW.getTime() - HOUR_MS) }),
      );

      await expect(
        service.accept('viewing-1', 'lister-1', acceptDto),
      ).rejects.toThrow(
        new BadRequestException('This home is no longer on the board'),
      );
      expect(viewings.save).not.toHaveBeenCalled();
    });

    it('refuses an answer across a block', async () => {
      viewings.findOne.mockResolvedValue(viewing());
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      await expect(
        service.accept('viewing-1', 'lister-1', acceptDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(viewings.save).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cancelling an accepted viewing
  // -------------------------------------------------------------------------
  describe('cancel', () => {
    it('lets the requester cancel an accepted viewing and tells the lister', async () => {
      viewings.findOne.mockResolvedValue(
        viewing({
          status: HousingViewingStatus.Accepted,
          acceptedSlot: new Date(NOW.getTime() + 48 * HOUR_MS),
        }),
      );

      const view = await service.cancel('viewing-1', 'guest-1');

      expect(view.status).toBe(HousingViewingStatus.Cancelled);
      expect(view.canCancel).toBe(false);
      expect(viewings.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: HousingViewingStatus.Cancelled }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'lister-1',
        NotificationType.HousingViewingCancelled,
        expect.objectContaining({
          viewingId: 'viewing-1',
          slug: 'benfica-room',
          title: 'Sunny room in Benfica',
        }),
        'guest-1',
      );
    });

    it('lets the lister cancel an accepted viewing and tells the requester', async () => {
      viewings.findOne.mockResolvedValue(
        viewing({
          status: HousingViewingStatus.Accepted,
          acceptedSlot: new Date(NOW.getTime() + 48 * HOUR_MS),
        }),
      );

      await service.cancel('viewing-1', 'lister-1');

      expect(notifications.create).toHaveBeenCalledWith(
        'guest-1',
        NotificationType.HousingViewingCancelled,
        expect.any(Object),
        'lister-1',
      );
    });

    it('keeps a completed viewing as it is', async () => {
      viewings.findOne.mockResolvedValue(
        viewing({
          status: HousingViewingStatus.Completed,
          acceptedSlot: new Date(NOW.getTime() - 48 * HOUR_MS),
        }),
      );

      await expect(
        service.cancel('viewing-1', 'guest-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(viewings.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. The unlock rule
  // -------------------------------------------------------------------------
  describe('hasUnlockedViewing', () => {
    it('stays closed across a block either way, without reading viewings', async () => {
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);

      await expect(
        service.hasUnlockedViewing('listing-1', 'guest-1', {
          listerId: 'lister-1',
        }),
      ).resolves.toBe(false);
      expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
        'guest-1',
        'lister-1',
      );
      expect(viewings.exists).not.toHaveBeenCalled();
    });

    it('counts only viewings from the current letting once the home is relisted', async () => {
      const relistedAt = new Date(NOW.getTime() - 24 * HOUR_MS);
      viewings.exists.mockResolvedValue(true);

      await expect(
        service.hasUnlockedViewing('listing-1', 'guest-1', {
          listerId: 'lister-1',
          relistedAt,
        }),
      ).resolves.toBe(true);
      // An accepted viewing counts when it was requested on or after the
      // relisting, and a completed one when its agreed slot was.
      expect(viewings.exists).toHaveBeenCalledWith({
        where: [
          {
            listingId: 'listing-1',
            requesterId: 'guest-1',
            status: HousingViewingStatus.Accepted,
            createdAt: MoreThanOrEqual(relistedAt),
          },
          {
            listingId: 'listing-1',
            requesterId: 'guest-1',
            status: HousingViewingStatus.Completed,
            acceptedSlot: MoreThanOrEqual(relistedAt),
          },
        ],
      });
    });

    it('closes the address to an accepted viewing that outlived a fill', async () => {
      // The repository answers the relisting-aware query: the only accepted
      // viewing predates the relisting, so nothing matches.
      viewings.exists.mockResolvedValue(false);

      await expect(
        service.hasUnlockedViewing('listing-1', 'guest-1', {
          listerId: 'lister-1',
          relistedAt: new Date(NOW.getTime() - HOUR_MS),
        }),
      ).resolves.toBe(false);
      const [{ where }] = viewings.exists.mock.calls[0] as [
        { where: Record<string, unknown>[] },
      ];
      expect(where[0]).toHaveProperty('createdAt');
    });

    it('counts every accepted and completed viewing on a home that was never relisted', async () => {
      await service.hasUnlockedViewing('listing-1', 'guest-1', {
        listerId: 'lister-1',
        relistedAt: null,
      });

      expect(viewings.exists).toHaveBeenCalledWith({
        where: [
          {
            listingId: 'listing-1',
            requesterId: 'guest-1',
            status: HousingViewingStatus.Accepted,
          },
          {
            listingId: 'listing-1',
            requesterId: 'guest-1',
            status: HousingViewingStatus.Completed,
          },
        ],
      });
    });

    it('keeps the two-argument call working with the block check skipped', async () => {
      viewings.exists.mockResolvedValue(true);

      await expect(
        service.hasUnlockedViewing('listing-1', 'guest-1'),
      ).resolves.toBe(true);
      expect(blockFilter.isBlockedEitherWay).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Closing a home's open viewings
  // -------------------------------------------------------------------------
  describe('closeOpenForListing', () => {
    it('cancels the open viewings in one guarded update and bells each requester it changed', async () => {
      updateBuilder.execute.mockResolvedValue({
        raw: [
          { id: 'viewing-1', requester_id: 'guest-1' },
          { id: 'viewing-2', requester_id: 'guest-2' },
        ],
        affected: 2,
      });

      await service.closeOpenForListing('listing-1', 'lister-1');

      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: HousingViewingStatus.Cancelled,
      });
      expect(updateBuilder.where).toHaveBeenCalledWith(
        'listing_id = :listingId',
        { listingId: 'listing-1' },
      );
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'status IN (:...openStatuses)',
        {
          openStatuses: [
            HousingViewingStatus.Requested,
            HousingViewingStatus.Accepted,
          ],
        },
      );
      expect(updateBuilder.returning).toHaveBeenCalledWith([
        'id',
        'requesterId',
      ]);
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { id: 'listing-1' },
        withDeleted: true,
      });
      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(notifications.create).toHaveBeenCalledWith(
        'guest-2',
        NotificationType.HousingViewingCancelled,
        expect.objectContaining({
          viewingId: 'viewing-2',
          slug: 'benfica-room',
        }),
        'lister-1',
      );
    });

    it('bells only the rows the update returned', async () => {
      // A viewing completed between the lister's click and this write keeps
      // its status, so the update returns just the one it changed.
      updateBuilder.execute.mockResolvedValue({
        raw: [{ id: 'viewing-1', requester_id: 'guest-1' }],
        affected: 1,
      });

      await service.closeOpenForListing('listing-1', 'lister-1');

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        'guest-1',
        NotificationType.HousingViewingCancelled,
        expect.objectContaining({ viewingId: 'viewing-1' }),
        'lister-1',
      );
    });

    it('sends no bell when the home has no open viewings', async () => {
      await service.closeOpenForListing('listing-1', 'lister-1');

      expect(listings.findOne).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('logs a failure and lets the lister action stand', async () => {
      updateBuilder.execute.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.closeOpenForListing('listing-1', 'lister-1'),
      ).resolves.toBeUndefined();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  // PRD-444: the expiry sweep hid these homes, so a requested viewing can
  // never be accepted. Accepted viewings stay for the lister to honour.
  describe('closeRequestedForListings', () => {
    it('cancels only requested viewings on the swept homes and bells each requester', async () => {
      updateBuilder.execute.mockResolvedValue({
        raw: [
          {
            id: 'viewing-1',
            requester_id: 'guest-1',
            lister_id: 'lister-1',
            listing_id: 'listing-1',
          },
          {
            id: 'viewing-2',
            requester_id: 'guest-2',
            lister_id: 'lister-2',
            listing_id: 'listing-2',
          },
        ],
        affected: 2,
      });
      listings.find.mockResolvedValue([
        liveListing(),
        liveListing({ id: 'listing-2', slug: 'graca-flat', title: 'Graca' }),
      ]);

      await service.closeRequestedForListings(['listing-1', 'listing-2']);

      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: HousingViewingStatus.Cancelled,
      });
      expect(updateBuilder.where).toHaveBeenCalledWith(
        'listing_id IN (:...listingIds)',
        { listingIds: ['listing-1', 'listing-2'] },
      );
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'status = :requested',
        { requested: HousingViewingStatus.Requested },
      );
      expect(updateBuilder.returning).toHaveBeenCalledWith([
        'id',
        'requesterId',
        'listerId',
        'listingId',
      ]);
      expect(listings.find).toHaveBeenCalledWith({
        where: { id: In(['listing-1', 'listing-2']) },
        select: { id: true, slug: true, title: true },
      });
      expect(notifications.create).toHaveBeenCalledTimes(2);
      expect(notifications.create).toHaveBeenCalledWith(
        'guest-2',
        NotificationType.HousingViewingCancelled,
        expect.objectContaining({
          viewingId: 'viewing-2',
          slug: 'graca-flat',
          title: 'Graca',
        }),
        'lister-2',
      );
    });

    it('skips the write entirely when the sweep hid nothing', async () => {
      await service.closeRequestedForListings([]);

      expect(viewings.createQueryBuilder).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('sends no bell when the swept homes had no requested viewings', async () => {
      await service.closeRequestedForListings(['listing-1']);

      expect(listings.find).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('logs a failure and lets the sweep stand', async () => {
      updateBuilder.execute.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.closeRequestedForListings(['listing-1']),
      ).resolves.toBeUndefined();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. The listing flags
  // -------------------------------------------------------------------------
  describe('listMine listing flags', () => {
    const declinedViewing = viewing({
      status: HousingViewingStatus.Declined,
    });

    it('marks a bookable home open and present', async () => {
      viewings.find.mockResolvedValue([declinedViewing]);

      const [view] = await service.listMine('guest-1');

      expect(view?.isListingOpen).toBe(true);
      expect(view?.isListingDeleted).toBe(false);
      expect(contentModeration.statesFor).toHaveBeenCalledWith('housing', [
        'benfica-room',
      ]);
      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith('guest-1', [
        'lister-1',
      ]);
    });

    it('closes a filled home and keeps it reviewable', async () => {
      viewings.find.mockResolvedValue([declinedViewing]);
      listings.find.mockResolvedValue([
        liveListing({ filledAt: new Date(NOW.getTime() - HOUR_MS) }),
      ]);

      const [view] = await service.listMine('guest-1');

      expect(view?.isListingOpen).toBe(false);
      expect(view?.isListingDeleted).toBe(false);
    });

    it('closes and flags a home the lister deleted', async () => {
      viewings.find.mockResolvedValue([declinedViewing]);
      listings.find.mockResolvedValue([
        liveListing({ deletedAt: new Date(NOW.getTime() - HOUR_MS) }),
      ]);

      const [view] = await service.listMine('guest-1');

      expect(view?.isListingOpen).toBe(false);
      expect(view?.isListingDeleted).toBe(true);
    });

    it('closes a home a moderator took down', async () => {
      viewings.find.mockResolvedValue([declinedViewing]);
      contentModeration.statesFor.mockResolvedValue(
        new Map([['benfica-room', { hidden: false, removed: true }]]),
      );

      const [view] = await service.listMine('guest-1');

      expect(view?.isListingOpen).toBe(false);
    });

    it('closes a home across a block either way with the lister', async () => {
      viewings.find.mockResolvedValue([declinedViewing]);
      blockFilter.blockedUserIds.mockResolvedValue(new Set(['lister-1']));

      const [view] = await service.listMine('guest-1');

      expect(view?.isListingOpen).toBe(false);
      expect(view?.isListingDeleted).toBe(false);
    });
  });
});
