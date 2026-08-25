import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ResourceListing,
  ResourceListingCategory,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
import { ResourceListingsService } from './resource-listings.service';

// Matches the exact shape `ResourceListingsService.list` passes to
// `repo.find` — narrower than TypeORM's polymorphic `FindManyOptions` so
// `callArgs.where.status` below doesn't need to fan out over every `where`
// shape TypeORM allows (string, array, ObjectId, ...).
interface ResourceListingFindArgs {
  where: {
    status: ResourceListingStatus;
    category?: ResourceListingCategory;
  };
  order: { title: 'ASC' };
  take: number;
}

const activeListing: ResourceListing = {
  id: 'rl-1',
  category: ResourceListingCategory.LegalAid,
  title: 'Coimbra Legal Aid Clinic',
  description: 'Free consultations for LGBTQ+ workplace discrimination.',
  phone: null,
  email: 'intake@coimbralegal.org',
  website: null,
  region: 'Coimbra',
  status: ResourceListingStatus.Active,
  createdBy: 'admin-1',
  updatedBy: 'admin-1',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('ResourceListingsService', () => {
  let service: ResourceListingsService;
  let repo: {
    find: jest.Mock<Promise<ResourceListing[]>, [ResourceListingFindArgs]>;
  };

  beforeEach(async () => {
    repo = {
      find: jest
        .fn<Promise<ResourceListing[]>, [ResourceListingFindArgs]>()
        .mockResolvedValue([activeListing]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourceListingsService,
        { provide: getRepositoryToken(ResourceListing), useValue: repo },
      ],
    }).compile();
    service = module.get(ResourceListingsService);
  });

  it('lists only active listings, ordered by title', async () => {
    const result = await service.list();

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: ResourceListingStatus.Active },
        order: { title: 'ASC' },
      }),
    );
    expect(result).toEqual([
      {
        id: 'rl-1',
        category: 'legal_aid',
        title: 'Coimbra Legal Aid Clinic',
        description: 'Free consultations for LGBTQ+ workplace discrimination.',
        phone: null,
        email: 'intake@coimbralegal.org',
        website: null,
        region: 'Coimbra',
      },
    ]);
  });

  it('filters by category when provided', async () => {
    await service.list(ResourceListingCategory.SexualHealthTesting);

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: ResourceListingStatus.Active,
          category: ResourceListingCategory.SexualHealthTesting,
        },
      }),
    );
  });

  it('never queries for archived listings, even implicitly', async () => {
    await service.list(ResourceListingCategory.LegalAid);

    const [callArgs] = repo.find.mock.calls[0]!;
    expect(callArgs.where).not.toEqual(
      expect.objectContaining({ status: ResourceListingStatus.Archived }),
    );
    expect(callArgs.where.status).toBe(ResourceListingStatus.Active);
  });
});
