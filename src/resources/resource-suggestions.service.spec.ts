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
  let repo: { create: jest.Mock; save: jest.Mock };

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
});
