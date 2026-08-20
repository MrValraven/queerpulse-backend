import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ResourceListing,
  ResourceListingCategory,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
import { AdminResourceListingsService } from './admin-resource-listings.service';

function makeListing(overrides: Partial<ResourceListing> = {}): ResourceListing {
  return {
    id: 'rl-1',
    category: ResourceListingCategory.LegalAid,
    title: 'Coimbra Legal Aid Clinic',
    description: 'Free consultations.',
    phone: '912 000 111',
    email: null,
    website: null,
    region: 'Coimbra',
    status: ResourceListingStatus.Active,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminResourceListingsService', () => {
  let service: AdminResourceListingsService;
  let repo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((v: Partial<ResourceListing>) => v),
      save: jest.fn((v: Partial<ResourceListing>) =>
        Promise.resolve({ ...makeListing(), ...v } as ResourceListing),
      ),
      delete: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminResourceListingsService,
        { provide: getRepositoryToken(ResourceListing), useValue: repo },
      ],
    }).compile();
    service = module.get(AdminResourceListingsService);
  });

  it('creates a listing stamped with the acting admin', async () => {
    const result = await service.create(
      {
        category: ResourceListingCategory.LegalAid,
        title: 'Coimbra Legal Aid Clinic',
        description: 'Free consultations.',
        phone: '912 000 111',
      },
      'admin-1',
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: 'admin-1',
        updatedBy: 'admin-1',
        status: ResourceListingStatus.Active,
      }),
    );
    expect(result.title).toBe('Coimbra Legal Aid Clinic');
  });

  it('404s updating a listing that does not exist', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.update('missing', { title: 'New title' }, 'admin-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an update that would leave the row with no contact field', async () => {
    repo.findOne.mockResolvedValue(
      makeListing({ phone: '912 000 111', email: null, website: null }),
    );
    await expect(
      service.update('rl-1', { phone: '' }, 'admin-2'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s removing a listing that does not exist', async () => {
    repo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
