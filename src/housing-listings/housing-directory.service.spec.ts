import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HousingViewingsService } from '../housing-viewings/housing-viewings.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { HousingDirectoryService } from './housing-directory.service';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
  HousingListingType,
} from './entities/housing-listing.entity';

type RepoMock = Record<string, jest.Mock>;
type QueryBuilderStub = Record<string, jest.Mock>;

/** Fluent builder covering both the paginated browse (`getManyAndCount`) and
 *  the capped search (`getMany`) terminals. */
function makeBuilder(
  terminals: {
    getManyAndCount?: [unknown[], number];
    getMany?: unknown[];
  } = {},
): QueryBuilderStub {
  const builder: QueryBuilderStub = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'skip', 'take']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getManyAndCount = jest
    .fn()
    .mockResolvedValue(terminals.getManyAndCount ?? [[], 0]);
  builder.getMany = jest.fn().mockResolvedValue(terminals.getMany ?? []);
  return builder;
}

function makeListing(overrides: Partial<HousingListing> = {}): HousingListing {
  return {
    id: 'listing-1',
    ref: 'QPH-2026-0001',
    slug: 'sunny-room',
    ownerId: 'owner-1',
    status: HousingListingStatus.Live,
    type: HousingListingType.Room,
    // Column default — member vs agent/broker disclosure badge.
    listerKind: HousingListerKind.Member,
    title: 'Sunny room',
    blurb: 'Bright',
    city: 'Lisbon',
    area: 'Arroios',
    rentEuros: 500,
    // Null = bedroom count not specified (additive nullable column; old rows
    // never backfilled).
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
    // Column default `''` for old rows (required going forward, enforced by
    // `CreateHousingListingDto`, not nullable at the DB).
    accessibilityInfo: '',
    // Column defaults — deterministic pre-publish risk score/reasons, never
    // exposed on public browse.
    riskScore: 0,
    riskReasons: [],
    // LOC-01 decision trail — null until a moderator has decided on the row.
    decisionReason: null,
    decidedById: null,
    decidedAt: null,
    // Null = lister added no virtual-tour link.
    virtualTourUrl: null,
    // Null = still looking / still live to the public (owner hasn't marked it
    // filled and the sweeper hasn't hidden it).
    filledAt: null,
    // NOT NULL on the entity — every listing always carries a real expiry.
    // Relative to NOW rather than a fixed date: `detail` 404s an expired
    // listing for everyone but its owner, so a hardcoded date silently turns
    // every "live listing" test red once the wall clock passes it.
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('HousingDirectoryService', () => {
  let service: HousingDirectoryService;
  // Declared with the exact method shape (rather than the bare `RepoMock`
  // index-signature alias) so `listings.findOne.mockResolvedValue(...)`-style
  // chained access doesn't see `noUncheckedIndexedAccess`'s `| undefined`.
  let listings: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let profiles: RepoMock;
  let contentModeration: { stateFor: jest.Mock };
  let verification: { levelForUser: jest.Mock; levelsForUsers: jest.Mock };
  let connections: { areConnected: jest.Mock };
  let viewings: { hasUnlockedViewing: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => makeBuilder()),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    verification = {
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Email),
      levelsForUsers: jest.fn().mockResolvedValue(new Map()),
    };
    // Default: viewer is NOT connected to the lister → area-only (privacy gate).
    connections = { areConnected: jest.fn().mockResolvedValue(false) };
    // Default: no accepted viewing → no address unlock via the viewing path.
    viewings = { hasUnlockedViewing: jest.fn().mockResolvedValue(false) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingDirectoryService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
        { provide: VerificationService, useValue: verification },
        { provide: ConnectionsService, useValue: connections },
        { provide: HousingViewingsService, useValue: viewings },
      ],
    }).compile();

    service = module.get(HousingDirectoryService);
  });

  describe('browse', () => {
    it('restricts to live listings and applies each supplied filter', async () => {
      const builder = makeBuilder({ getManyAndCount: [[makeListing()], 1] });
      listings.createQueryBuilder.mockReturnValue(builder);

      const result = await service.browse({
        page: 1,
        type: HousingListingType.Room,
        city: 'Lisbon',
        priceMin: 300,
        priceMax: 900,
        availableBy: '2026-03-01',
      });

      expect(builder.where).toHaveBeenCalledWith('l.status = :live', {
        live: HousingListingStatus.Live,
      });
      // Each optional filter contributes an andWhere; the moderation takedown
      // predicate adds one more, so at least the six filters plus that.
      expect(builder.andWhere).toHaveBeenCalledWith('l.type = :type', {
        type: HousingListingType.Room,
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        'l.rent_euros >= :priceMin',
        {
          priceMin: 300,
        },
      );
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(1);
    });

    it('filters by multiple neighbourhoods (areas IN, case-insensitive)', async () => {
      const builder = makeBuilder({ getManyAndCount: [[], 0] });
      listings.createQueryBuilder.mockReturnValue(builder);

      await service.browse({
        areas: ['Arroios', 'Misericórdia'],
      });

      expect(builder.andWhere).toHaveBeenCalledWith(
        'LOWER(l.area) = ANY(:areas)',
        { areas: ['arroios', 'misericórdia'] },
      );
    });

    it('returns an empty envelope without hydrating listers when no rows match', async () => {
      listings.createQueryBuilder.mockReturnValue(
        makeBuilder({ getManyAndCount: [[], 0] }),
      );

      const result = await service.browse({});

      expect(result.items).toEqual([]);
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });

  describe('searchByText', () => {
    it('searches live listings with an ILIKE pattern bounded by the limit', async () => {
      const builder = makeBuilder({ getMany: [makeListing()] });
      listings.createQueryBuilder.mockReturnValue(builder);

      const rows = await service.searchByText('sunny', 5);

      expect(builder.take).toHaveBeenCalledWith(5);
      expect(rows).toEqual([
        {
          slug: 'sunny-room',
          title: 'Sunny room',
          city: 'Lisbon',
          area: 'Arroios',
        },
      ]);
    });
  });

  describe('detail', () => {
    it('404s when there is no live listing for the slug', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(service.detail('ghost', 'viewer-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a live listing that is under a moderator takedown (hidden or removed)', async () => {
      listings.findOne.mockResolvedValue(makeListing());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.detail('sunny-room', 'viewer-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the hydrated DTO for a visible live listing', async () => {
      listings.findOne.mockResolvedValue(makeListing());
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: false,
      });

      const result = await service.detail('sunny-room', 'viewer-1');

      expect(result.slug).toBe('sunny-room');
      expect(result.lister).toBeNull();
    });

    it('withholds the exact point/address from an unconnected viewer (area only)', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          latitude: 38.7169,
          longitude: -9.1487,
          addressLine: 'Rua Secreta 1',
        }),
      );
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: false,
      });
      connections.areConnected.mockResolvedValue(false);

      const result = await service.detail('sunny-room', 'stranger-1');

      expect(result.locationPrecision).toBe('area');
      expect(result.preciseLatitude).toBeNull();
      expect(result.addressLine).toBeNull();
      // The approximate neighbourhood pin is still provided (Arroios centroid).
      expect(result.approxLatitude).not.toBeNull();
    });

    it('discloses the exact point/address to a connected viewer', async () => {
      listings.findOne.mockResolvedValue(
        makeListing({
          latitude: 38.7169,
          longitude: -9.1487,
          addressLine: 'Rua Secreta 1',
        }),
      );
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: false,
      });
      connections.areConnected.mockResolvedValue(true);

      const result = await service.detail('sunny-room', 'friend-1');

      expect(result.locationPrecision).toBe('exact');
      expect(result.preciseLatitude).toBe(38.7169);
      expect(result.addressLine).toBe('Rua Secreta 1');
    });
  });
});
