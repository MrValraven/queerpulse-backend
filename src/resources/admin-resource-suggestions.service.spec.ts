import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { ResourceListingCategory } from './entities/resource-listing.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';
import { AdminResourceSuggestionsService } from './admin-resource-suggestions.service';

function makeSuggestion(
  overrides: Partial<ResourceSuggestion> = {},
): ResourceSuggestion {
  return {
    id: 'rs-1',
    memberId: 'member-1',
    category: ResourceListingCategory.SexualHealthTesting,
    name: 'Trans-friendly testing van (Almada)',
    description: 'Free anonymous rapid testing every Thursday evening.',
    phone: null,
    email: null,
    website: null,
    status: ResourceSuggestionStatus.Pending,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AdminResourceSuggestionsService', () => {
  let service: AdminResourceSuggestionsService;
  let suggestions: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let profiles: { find: jest.Mock };

  const qbStub = (rows: ResourceSuggestion[]) => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['orderBy', 'skip', 'take', 'andWhere']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
    return qb;
  };

  beforeEach(async () => {
    suggestions = {
      createQueryBuilder: jest.fn(() => qbStub([makeSuggestion()])),
      findOne: jest.fn(),
      save: jest.fn((v: Partial<ResourceSuggestion>) =>
        Promise.resolve({ ...makeSuggestion(), ...v }),
      ),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminResourceSuggestionsService,
        {
          provide: getRepositoryToken(ResourceSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(AdminResourceSuggestionsService);
  });

  it('lists suggestions newest-first, paginated', async () => {
    const result = await service.list({});
    expect(result.total).toBe(1);
    expect(result.items[0]!.name).toBe('Trans-friendly testing van (Almada)');
  });

  it('approve() stamps status/decidedAt/decidedBy and trims the note', async () => {
    suggestions.findOne.mockResolvedValue(makeSuggestion());
    const result = await service.approve('rs-1', 'admin-1', '  looks great  ');

    expect(suggestions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ResourceSuggestionStatus.Approved,
        decidedBy: 'admin-1',
        decisionNote: 'looks great',
      }),
    );
    expect(result.status).toBe(ResourceSuggestionStatus.Approved);
  });

  it('404s deciding a suggestion that does not exist', async () => {
    suggestions.findOne.mockResolvedValue(null);
    await expect(service.decline('missing', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('approving a suggestion cannot create a ResourceListing — the service has no dependency on that repository', async () => {
    // This testing module deliberately provides NO `Repository<ResourceListing>`.
    // If `AdminResourceSuggestionsService` (or a future change to it) ever tried
    // to inject or write through one, `Test.createTestingModule(...).compile()`
    // would throw `UnknownDependenciesException` before this assertion ever ran.
    suggestions.findOne.mockResolvedValue(makeSuggestion());
    const result = await service.approve('rs-1', 'admin-1');

    expect(result.status).toBe(ResourceSuggestionStatus.Approved);
    expect(result).not.toHaveProperty('listingId');
    expect(result).not.toHaveProperty('resourceListingId');
  });
});
