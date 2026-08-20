import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from '../notifications/notifications.service';
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
  let listings: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let suggestions: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((listing) => Promise.resolve(listing)),
    };
    suggestions = {
      create: jest.fn((input: Partial<ListingEditSuggestion>) => input),
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    profiles = { find: jest.fn() };
    notifications = { create: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingEditSuggestionsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(ListingEditSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: NotificationsService, useValue: notifications },
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
        listingId: 'listing-1',
        field: 'address',
        message: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'galeria-lume',
        address: 'old address',
        social: { phone: '', website: '', email: '', instagram: '' },
      });

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

    it('applies an accepted address correction onto the listing and notifies the owner', async () => {
      const suggestion = {
        id: 'sugg-1',
        listingId: 'listing-1',
        field: 'address',
        message: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'galeria-lume',
        address: 'old address',
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-1', 'mod-1', { status: 'accepted' });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ address: '123 New Street' }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        'listing_edit_suggestion_accepted',
        { source: 'listing', listingSlug: 'galeria-lume', field: 'address' },
      );
    });

    it('applies an accepted phone correction into listing.social without disturbing other social fields', async () => {
      const suggestion = {
        id: 'sugg-2',
        listingId: 'listing-1',
        field: 'phone',
        message: '+351 900 000 000',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'galeria-lume',
        social: {
          phone: 'old-phone',
          website: 'example.com',
          email: '',
          instagram: '',
        },
      });

      await service.resolve('sugg-2', 'mod-1', { status: 'accepted' });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          social: expect.objectContaining({
            phone: '+351 900 000 000',
            website: 'example.com',
          }),
        }),
      );
    });

    it('does not touch any listing column for an accepted "other" suggestion, but still notifies the owner', async () => {
      const suggestion = {
        id: 'sugg-3',
        listingId: 'listing-1',
        field: 'other',
        message: 'The owner changed, please update everything.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'galeria-lume',
      });

      await service.resolve('sugg-3', 'mod-1', { status: 'accepted' });

      expect(listings.save).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        'listing_edit_suggestion_accepted',
        { source: 'listing', listingSlug: 'galeria-lume', field: 'other' },
      );
    });

    it('dismisses a suggestion without touching the listing', async () => {
      const suggestion = {
        id: 'sugg-4',
        listingId: 'listing-1',
        field: 'address',
        message: 'ignored on dismiss',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));

      const result = await service.resolve('sugg-4', 'mod-1', {
        status: 'dismissed',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Dismissed);
      expect(listings.findOne).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('404s when the suggestion id does not exist', async () => {
      suggestions.findOne.mockResolvedValue(null);

      await expect(
        service.resolve('missing', 'mod-1', { status: 'accepted' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('never throws out of resolve() when the listing was hard-deleted since', async () => {
      const suggestion = {
        id: 'sugg-5',
        listingId: 'gone',
        field: 'address',
        message: 'irrelevant now',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue(null);

      const result = await service.resolve('sugg-5', 'mod-1', {
        status: 'accepted',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Accepted);
      expect(listings.save).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
