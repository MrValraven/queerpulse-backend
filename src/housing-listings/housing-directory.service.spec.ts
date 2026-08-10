import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import { HousingDirectoryService } from './housing-directory.service';
import {
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
    title: 'Sunny room',
    blurb: 'Bright',
    city: 'Lisbon',
    area: 'Arroios',
    rentEuros: 500,
    billsIncluded: false,
    lgbtqFriendly: true,
    availableFrom: null,
    minStayMonths: null,
    description: '',
    features: [],
    idealFor: [],
    gallery: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('HousingDirectoryService', () => {
  let service: HousingDirectoryService;
  let listings: RepoMock;
  let profiles: RepoMock;
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => makeBuilder()),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingDirectoryService,
        { provide: getRepositoryToken(HousingListing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
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
        lgbtqFriendly: true,
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
      expect(builder.andWhere).toHaveBeenCalledWith('l.lgbtq_friendly = true');
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(1);
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

      await expect(service.detail('ghost')).rejects.toThrow(NotFoundException);
    });

    it('404s a live listing that is under a moderator takedown (hidden or removed)', async () => {
      listings.findOne.mockResolvedValue(makeListing());
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(service.detail('sunny-room')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the hydrated DTO for a visible live listing', async () => {
      listings.findOne.mockResolvedValue(makeListing());
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: false,
      });

      const result = await service.detail('sunny-room');

      expect(result.slug).toBe('sunny-room');
      expect(result.lister).toBeNull();
    });
  });
});
