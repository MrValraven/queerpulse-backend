import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { HousingListingDecision } from './dto/decide-housing-listing.dto';
import { HousingReviewQueueSort } from './dto/housing-review-queue.query';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
  HousingListingType,
} from './entities/housing-listing.entity';
import { HousingListingModerationService } from './housing-listing-moderation.service';
import { HOUSING_LISTING_WENT_LIVE } from './housing-listing.events';

type QueryBuilderStub = Record<string, jest.Mock>;

function makeListing(overrides: Partial<HousingListing> = {}): HousingListing {
  return {
    id: 'listing-1',
    ref: 'QPH-2026-0001',
    slug: 'sunny-room',
    ownerId: 'owner-1',
    status: HousingListingStatus.Review,
    type: HousingListingType.Room,
    listerKind: HousingListerKind.Member,
    title: 'Sunny room',
    blurb: '',
    city: 'Lisbon',
    area: 'Arroios',
    rentEuros: 500,
    bedrooms: null,
    billsIncluded: false,
    lgbtqFriendly: true,
    availableFrom: null,
    minStayMonths: null,
    description: '',
    features: [],
    idealFor: [],
    gallery: [],
    latitude: null,
    longitude: null,
    addressLine: null,
    accessibilityInfo: '',
    riskScore: 0,
    riskReasons: [],
    decisionReason: null,
    decidedById: null,
    decidedAt: null,
    virtualTourUrl: null,
    filledAt: null,
    expiresAt: new Date('2026-03-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * `mapRowsForAdmin` (the tail of every path here) runs the lister-history
 * aggregate through a query builder, and `reviewQueue` runs the page itself
 * through another. One stub serves both: every chained method returns itself,
 * `getRawMany` answers the history query and `getManyAndCount` the page.
 */
function makeQueryBuilder(
  rows: HousingListing[] = [],
  total = 0,
  rawRows: unknown[] = [],
): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getRawMany = jest.fn().mockResolvedValue(rawRows);
  builder.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return builder;
}

describe('HousingListingModerationService', () => {
  let service: HousingListingModerationService;
  let listings: {
    findOne: jest.Mock;
    save: jest.Mock<Promise<HousingListing>, [HousingListing]>;
    createQueryBuilder: jest.Mock;
  };
  let profiles: Record<string, jest.Mock>;
  let modAuditLogs: Record<string, jest.Mock>;
  let verification: { levelForUser: jest.Mock; levelsForUsers: jest.Mock };
  let notifications: { create: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((row: HousingListing) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => makeQueryBuilder()),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    modAuditLogs = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };
    verification = {
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Phone),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };
    eventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingListingModerationService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(ModAuditLog), useValue: modAuditLogs },
        { provide: VerificationService, useValue: verification },
        { provide: NotificationsService, useValue: notifications },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(HousingListingModerationService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('decide', () => {
    it('404s an unknown ref', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.decide('QPH-x', 'mod-1', {
          decision: HousingListingDecision.Approve,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('approves a pending listing to live and emits HOUSING_LISTING_WENT_LIVE', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      const result = await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Approve,
      });

      expect(result.status).toBe(HousingListingStatus.Live);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      const [eventName, event] = eventEmitter.emit.mock.calls[0] as [
        string,
        { listing: HousingListing; listingVerified: boolean },
      ];
      expect(eventName).toBe(HOUSING_LISTING_WENT_LIVE);
      expect(event.listing.status).toBe(HousingListingStatus.Live);
      // The lister here is only phone-verified, so the honest "verified
      // listing" chip is withheld even though the listing is live.
      expect(event.listingVerified).toBe(false);
    });

    it('refreshes an expired listing on approval so browse does not withhold it', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          status: HousingListingStatus.Review,
          // Sat in the queue past its own 60-day window.
          expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      );

      await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Approve,
      });

      const [saved] = listings.save.mock.calls[0] as [HousingListing];
      expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('records who decided and when, and stamps the reason', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.RequestChanges,
        reason: 'Please add at least one photo of the room itself.',
      });

      const [saved] = listings.save.mock.calls[0] as [HousingListing];
      expect(saved.status).toBe(HousingListingStatus.Question);
      expect(saved.decidedById).toBe('mod-1');
      expect(saved.decidedAt).toBeInstanceOf(Date);
      expect(saved.decisionReason).toBe(
        'Please add at least one photo of the room itself.',
      );
    });

    it('rejects a listing WITHOUT ever making it live, and never emits the go-live event', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      const result = await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Reject,
        reason:
          'The rent is far below market and the text asks for a transfer.',
      });

      expect(result.status).toBe(HousingListingStatus.Rejected);
      const [saved] = listings.save.mock.calls[0] as [HousingListing];
      expect(saved.status).toBe(HousingListingStatus.Rejected);
      expect(saved.status).not.toBe(HousingListingStatus.Live);
      // Nothing downstream of publication may fire for a refused listing: no
      // saved-search alert reaches anybody about a home that was never
      // published.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('requires a reason for everything except an approval', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      await expect(
        service.decide('QPH-2026-0001', 'mod-1', {
          decision: HousingListingDecision.Reject,
        }),
      ).rejects.toThrow(BadRequestException);
      // Refused before any write: a listing is never left half-decided.
      expect(listings.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refuses a take-down on a listing that is not live', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      await expect(
        service.decide('QPH-2026-0001', 'mod-1', {
          decision: HousingListingDecision.TakeDown,
          reason: 'Reported by three members.',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a decision that would not change anything', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Live }),
      );

      await expect(
        service.decide('QPH-2026-0001', 'mod-1', {
          decision: HousingListingDecision.Approve,
        }),
      ).rejects.toThrow(BadRequestException);
      // A no-op re-approval must not re-notify the lister or re-fire alerts.
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('tells the lister, with the reason, and names no moderator', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Reject,
        reason: 'The listing asks for a deposit before a viewing.',
      });

      expect(notifications.create).toHaveBeenCalledTimes(1);
      const [userId, type, payload, actorId] = notifications.create.mock
        .calls[0] as [
        string,
        NotificationType,
        Record<string, unknown>,
        unknown,
      ];
      expect(userId).toBe('owner-1');
      expect(type).toBe(NotificationType.HousingListingDecision);
      expect(payload).toEqual({
        source: 'housing',
        slug: 'sunny-room',
        title: 'Sunny room',
        decision: HousingListingDecision.Reject,
        reason: 'The listing asks for a deposit before a viewing.',
      });
      // No actor id: the bell never names which moderator acted, and a block
      // between the two of them must not suppress a decision about the
      // member's own listing.
      expect(actorId).toBeUndefined();
    });

    it('writes one immutable audit row naming the lister and the listing', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );

      await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Reject,
        reason: 'Discriminatory wording in the ideal-for chips.',
      });

      expect(modAuditLogs.save).toHaveBeenCalledTimes(1);
      const [row] = modAuditLogs.create!.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(row.action).toBe('housing_listing_rejected');
      expect(row.actorId).toBe('mod-1');
      expect(row.targetUserId).toBe('owner-1');
      expect(row.note).toBe(
        'QPH-2026-0001: Discriminatory wording in the ideal-for chips.',
      );
    });

    it('does not fail the decision when the lister notification throws', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review }),
      );
      notifications.create.mockRejectedValue(new Error('bell is down'));

      const result = await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Approve,
      });

      expect(result.status).toBe(HousingListingStatus.Live);
    });

    it('notifies nobody when the lister erased their account', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({ status: HousingListingStatus.Review, ownerId: null }),
      );

      await service.decide('QPH-2026-0001', 'mod-1', {
        decision: HousingListingDecision.Approve,
      });

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('reviewQueue', () => {
    it('defaults to pending listings sorted riskiest first', async () => {
      const builder = makeQueryBuilder([], 0);
      listings.createQueryBuilder.mockReturnValue(builder);

      await service.reviewQueue({});

      expect(builder.where).toHaveBeenCalledWith('l.status = :status', {
        status: HousingListingStatus.Review,
      });
      expect(builder.orderBy).toHaveBeenCalledWith('l.risk_score', 'DESC');
      // Ties break oldest-first so nothing at a given score is starved.
      expect(builder.addOrderBy).toHaveBeenCalledWith('l.created_at', 'ASC');
    });

    it('does not filter by status at all when asked for everything', async () => {
      const builder = makeQueryBuilder([], 0);
      listings.createQueryBuilder.mockReturnValue(builder);

      await service.reviewQueue({ status: 'all' });

      expect(builder.where).not.toHaveBeenCalled();
    });

    it('honours an explicit sort', async () => {
      const builder = makeQueryBuilder([], 0);
      listings.createQueryBuilder.mockReturnValue(builder);

      await service.reviewQueue({ sort: HousingReviewQueueSort.Newest });

      expect(builder.orderBy).toHaveBeenCalledWith('l.created_at', 'DESC');
    });

    it('carries the risk signals and the exact address for the moderator', async () => {
      const row = makeListing({
        status: HousingListingStatus.Review,
        riskScore: 55,
        riskReasons: ['rent_far_below_market', 'lister_phone_only'],
        addressLine: 'Rua Example 10, 3 Esq',
        latitude: 38.72984,
        longitude: -9.13881,
      });
      listings.createQueryBuilder.mockReturnValue(makeQueryBuilder([row], 1));

      const page = await service.reviewQueue({});

      const [item] = page.items;
      expect(item?.riskScore).toBe(55);
      expect(item?.riskReasons).toEqual([
        'rent_far_below_market',
        'lister_phone_only',
      ]);
      // A moderator is reviewing a real home, so the exact point and address
      // are theirs to see. No other route returns this DTO.
      expect(item?.addressLine).toBe('Rua Example 10, 3 Esq');
      expect(item?.locationPrecision).toBe('exact');
    });
  });
});
