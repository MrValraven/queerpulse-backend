import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { Profile } from '../users/entities/profile.entity';

describe('ListingEditSuggestionsService', () => {
  let service: ListingEditSuggestionsService;
  let listings: { findOne: jest.Mock; find: jest.Mock };
  let suggestions: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };

  beforeEach(async () => {
    listings = { findOne: jest.fn(), find: jest.fn() };
    suggestions = {
      create: jest.fn((input: Partial<ListingEditSuggestion>) => input),
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    profiles = { find: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingEditSuggestionsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(ListingEditSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(ListingEditSuggestionsService);
  });

  describe('submit', () => {
    const dto: CreateEditSuggestionDto = {
      field: 'hours',
      message: 'The Sunday hours listed are wrong.',
    };

    it('creates a pending suggestion scoped to the listing and submitter', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      const result = await service.submit('galeria-lume', 'member-1', dto);

      expect(listings.findOne).toHaveBeenCalledWith({
        where: { slug: 'galeria-lume', status: ListingStatus.Live },
      });
      expect(suggestions.create).toHaveBeenCalledWith({
        listingId: 'listing-1',
        suggestedByUserId: 'member-1',
        field: 'hours',
        message: 'The Sunday hours listed are wrong.',
        status: ListingEditSuggestionStatus.Pending,
      });
      expect(result).toEqual({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });
    });

    it('rejects a message that is only whitespace after trimming', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });

      await expect(
        service.submit('galeria-lume', 'member-1', {
          field: 'hours',
          message: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
    });

    it('rejects the listing owner suggesting an edit on their own listing', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });

      await expect(
        service.submit('galeria-lume', 'owner-1', dto),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
    });

    it('404s when the listing slug does not resolve to a live listing', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.submit('unknown-slug', 'member-1', dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolve', () => {
    it('accepts a pending suggestion and stamps the moderator/timestamp', async () => {
      const suggestion = {
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));

      const dto: ResolveEditSuggestionDto = { status: 'accepted' };
      const result = await service.resolve('sugg-1', 'mod-1', dto);

      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Accepted);
      expect(suggestion.resolvedByUserId).toBe('mod-1');
      expect(suggestion.resolvedAt).toBeInstanceOf(Date);
      expect(result).toEqual({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Accepted,
      });
    });

    it('dismisses a suggestion', async () => {
      const suggestion = {
        id: 'sugg-2',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));

      const result = await service.resolve('sugg-2', 'mod-1', {
        status: 'dismissed',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Dismissed);
    });

    it('404s when the suggestion id does not exist', async () => {
      suggestions.findOne.mockResolvedValue(null);

      await expect(
        service.resolve('missing', 'mod-1', { status: 'accepted' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
