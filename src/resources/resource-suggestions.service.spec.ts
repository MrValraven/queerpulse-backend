import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ResourceListingCategory } from './entities/resource-listing.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';
import { CreateResourceSuggestionDto } from './dto/create-resource-suggestion.dto';
import { ResourceSuggestionsService } from './resource-suggestions.service';

const now = new Date('2026-08-20T12:00:00.000Z');

describe('ResourceSuggestionsService', () => {
  let service: ResourceSuggestionsService;
  let repo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((v: Partial<ResourceSuggestion>) => v),
      save: jest.fn((v: Partial<ResourceSuggestion>) =>
        Promise.resolve({
          id: 'rs-1',
          status: ResourceSuggestionStatus.Pending,
          decidedAt: null,
          decidedBy: null,
          decisionNote: null,
          createdAt: now,
          ...v,
        } as ResourceSuggestion),
      ),
      find: jest.fn().mockResolvedValue([]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResourceSuggestionsService,
        { provide: getRepositoryToken(ResourceSuggestion), useValue: repo },
      ],
    }).compile();
    service = module.get(ResourceSuggestionsService);
  });

  const dto: CreateResourceSuggestionDto = {
    category: ResourceListingCategory.SexualHealthTesting,
    name: 'Trans-friendly testing van (Almada)',
    description: 'Free anonymous rapid testing every Thursday evening.',
    phone: '  912 000 111  ',
    email: '',
    website: undefined,
  };

  it('scopes the suggestion to the calling member and trims contact fields', async () => {
    const result = await service.create('u1', dto);

    expect(repo.create).toHaveBeenCalledWith({
      memberId: 'u1',
      category: dto.category,
      name: dto.name,
      description: dto.description,
      phone: '912 000 111',
      email: null,
      website: null,
    });
    expect(result).toEqual({
      id: 'rs-1',
      category: dto.category,
      name: dto.name,
      description: dto.description,
      phone: '912 000 111',
      email: null,
      website: null,
      createdAt: now.toISOString(),
    });
  });

  describe('listMine (PRD-45)', () => {
    const decided = new Date('2026-08-28T09:30:00.000Z');

    const declinedRow = {
      id: 'rs-9',
      memberId: 'u1',
      category: ResourceListingCategory.LegalAid,
      name: 'A clinic that closed in 2019',
      description: 'Free employment-law advice.',
      phone: null,
      email: null,
      website: null,
      status: ResourceSuggestionStatus.Declined,
      decidedAt: decided,
      decidedBy: 'admin-7',
      decisionNote: 'They closed in 2019, so we cannot list them.',
      createdAt: now,
    } as ResourceSuggestion;

    it('scopes to the caller and orders newest-first with an id tiebreak', async () => {
      await service.listMine('u1');

      expect(repo.find).toHaveBeenCalledWith({
        where: { memberId: 'u1' },
        // `created_at DESC` alone is not a total order: two rows written in
        // the same transaction share a `now()` and Postgres may then return
        // them in either order on either request. The `id` tiebreak is what
        // stops the tracker flickering between refetches.
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 50,
      });
    });

    it('tells the member the status, the decision time and the reviewer note', async () => {
      repo.find.mockResolvedValue([declinedRow]);

      const result = await service.listMine('u1');

      expect(result.items).toEqual([
        {
          id: 'rs-9',
          category: ResourceListingCategory.LegalAid,
          name: 'A clinic that closed in 2019',
          description: 'Free employment-law advice.',
          phone: null,
          email: null,
          website: null,
          createdAt: now.toISOString(),
          status: ResourceSuggestionStatus.Declined,
          decidedAt: decided.toISOString(),
          decisionNote: 'They closed in 2019, so we cannot list them.',
        },
      ]);
    });

    it('never puts the reviewing admin, or the member id, on the wire', async () => {
      repo.find.mockResolvedValue([declinedRow]);

      const [item] = (await service.listMine('u1')).items;

      // There is no global serializer in this codebase, so this is the only
      // thing standing between `decidedBy` and the member who was decided on.
      expect(item).not.toHaveProperty('decidedBy');
      expect(item).not.toHaveProperty('memberId');
      expect(JSON.stringify(item)).not.toContain('admin-7');
    });

    it('answers an object with an empty list, never null, for a member who has suggested nothing', async () => {
      repo.find.mockResolvedValue([]);

      // react-query throws "Query data cannot be undefined" on a null body,
      // so the empty answer has to be a real object.
      await expect(service.listMine('u1')).resolves.toEqual({ items: [] });
    });
  });
});
