import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import {
  Listing,
  ListingSocial,
  ListingStatus,
} from './entities/listing.entity';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { Profile } from '../users/entities/profile.entity';

describe('ListingEditSuggestionsService', () => {
  let service: ListingEditSuggestionsService;
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock<Promise<Partial<Listing>>, [Partial<Listing>]>;
  };
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
      save: jest.fn((listing: Partial<Listing>) => Promise.resolve(listing)),
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
        proposedValue: null,
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

    it('stores a trimmed proposed replacement value alongside the prose', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      await service.submit('galeria-lume', 'member-1', {
        field: 'phone',
        message: 'They changed their number last month.',
        proposedValue: '  +351 900 000 000  ',
      });

      expect(suggestions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          field: 'phone',
          proposedValue: '+351 900 000 000',
        }),
      );
    });

    it('stores null when the proposed value is only whitespace, keeping prose-only submissions valid', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      await service.submit('galeria-lume', 'member-1', {
        field: 'hours',
        message: 'The Sunday hours are wrong, I am not sure what they are now.',
        proposedValue: '   ',
      });

      expect(suggestions.create).toHaveBeenCalledWith(
        expect.objectContaining({ proposedValue: null }),
      );
    });
  });

  /**
   * The submit-time gate lives on `CreateEditSuggestionDto` so the global
   * `ValidationPipe` returns it as a 400 before the service is ever reached.
   * Exercised here through `validate()` on a real DTO instance, which is what
   * the pipe itself runs.
   */
  describe('CreateEditSuggestionDto.proposedValue validation', () => {
    async function validateBody(
      body: Record<string, unknown>,
    ): Promise<string[]> {
      const instance = plainToInstance(CreateEditSuggestionDto, body);
      const errors = await validate(instance);
      return errors.flatMap((error) => Object.values(error.constraints ?? {}));
    }

    it('accepts a submission with prose alone', async () => {
      expect(
        await validateBody({
          field: 'hours',
          message: 'The Sunday hours are wrong.',
        }),
      ).toEqual([]);
    });

    it('accepts a proposed value that satisfies the target column rules', async () => {
      expect(
        await validateBody({
          field: 'website',
          message: 'Their site moved.',
          proposedValue: 'https://galerialume.pt',
        }),
      ).toEqual([]);
    });

    it('rejects a proposed website the create path would reject, at submit time', async () => {
      const messages = await validateBody({
        field: 'website',
        message: 'Their site moved.',
        proposedValue: 'javascript:alert(1)',
      });

      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join(' ')).toContain('website');
    });

    it('rejects a proposed phone longer than the phone column allows', async () => {
      const messages = await validateBody({
        field: 'phone',
        message: 'New number.',
        proposedValue: '9'.repeat(61),
      });

      expect(messages.length).toBeGreaterThan(0);
    });

    it('rejects a proposed value on the "other" bucket, which has no writable column', async () => {
      const messages = await validateBody({
        field: 'other',
        message: 'The owner changed.',
        proposedValue: 'Someone else runs it now',
      });

      expect(messages.join(' ')).toContain('other');
    });

    it('treats a blank proposed value as absent rather than as an error', async () => {
      expect(
        await validateBody({
          field: 'hours',
          message: 'The Sunday hours are wrong.',
          proposedValue: '   ',
        }),
      ).toEqual([]);
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
          }) as ListingSocial,
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

    it('writes the suggester proposed value instead of the prose when the row carries one', async () => {
      const suggestion = {
        id: 'sugg-6',
        listingId: 'listing-1',
        field: 'phone',
        message: 'They changed their number last month.',
        proposedValue: '+351 900 000 000',
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

      await service.resolve('sugg-6', 'mod-1', { status: 'accepted' });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({
          social: expect.objectContaining({
            phone: '+351 900 000 000',
          }) as ListingSocial,
        }),
      );
    });

    it('lets a moderator value override the suggester proposed value', async () => {
      const suggestion = {
        id: 'sugg-7',
        listingId: 'listing-1',
        field: 'address',
        message: 'They moved across the street.',
        proposedValue: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
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

      await service.resolve('sugg-7', 'mod-1', {
        status: 'accepted',
        value: '123 New Street, Floor 2',
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ address: '123 New Street, Floor 2' }),
      );
    });

    it('falls back to the prose message when neither a proposal nor a moderator value is present', async () => {
      const suggestion = {
        id: 'sugg-8',
        listingId: 'listing-1',
        field: 'address',
        message: '123 New Street',
        proposedValue: null,
        status: ListingEditSuggestionStatus.Pending,
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

      await service.resolve('sugg-8', 'mod-1', { status: 'accepted' });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ address: '123 New Street' }),
      );
    });

    it('rejects a moderator value that the target column would refuse, before resolving the row', async () => {
      const suggestion = {
        id: 'sugg-9',
        listingId: 'listing-1',
        field: 'website',
        message: 'Their site moved.',
        proposedValue: 'https://galerialume.pt',
        status: ListingEditSuggestionStatus.Pending,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      suggestions.findOne.mockResolvedValue(suggestion);

      await expect(
        service.resolve('sugg-9', 'mod-1', {
          status: 'accepted',
          value: 'javascript:alert(1)',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Pending);
    });

    it('rejects a moderator value on an "other" suggestion, which has no column to write to', async () => {
      const suggestion = {
        id: 'sugg-10',
        listingId: 'listing-1',
        field: 'other',
        message: 'The owner changed.',
        proposedValue: null,
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);

      await expect(
        service.resolve('sugg-10', 'mod-1', {
          status: 'accepted',
          value: 'Someone else runs it now',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
    });

    it('rejects a moderator value on a dismissal, which writes nothing', async () => {
      const suggestion = {
        id: 'sugg-11',
        listingId: 'listing-1',
        field: 'address',
        message: 'They moved.',
        proposedValue: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);

      await expect(
        service.resolve('sugg-11', 'mod-1', {
          status: 'dismissed',
          value: '123 New Street',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
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

  describe('listForAdmin', () => {
    it('exposes the suggester proposed value on the queue row next to the prose', async () => {
      const rows = [
        {
          id: 'sugg-1',
          listingId: 'listing-1',
          suggestedByUserId: 'member-1',
          field: 'phone',
          message: 'They changed their number last month.',
          proposedValue: '+351 900 000 000',
          status: ListingEditSuggestionStatus.Pending,
          createdAt: new Date('2026-08-24T10:00:00.000Z'),
        },
        {
          id: 'sugg-2',
          listingId: 'listing-1',
          suggestedByUserId: null,
          field: 'hours',
          message: 'The Sunday hours are wrong, I am not sure what they are.',
          proposedValue: null,
          status: ListingEditSuggestionStatus.Pending,
          createdAt: new Date('2026-08-24T09:00:00.000Z'),
        },
      ];
      const queryBuilder = {
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      suggestions.createQueryBuilder.mockReturnValue(queryBuilder);
      listings.find.mockResolvedValue([
        { id: 'listing-1', ref: 'LST-1', name: 'Galeria Lume' },
      ]);
      profiles.find.mockResolvedValue([]);

      const queue = await service.listForAdmin({});

      expect(queue).toHaveLength(2);
      expect(queue[0]).toEqual(
        expect.objectContaining({
          id: 'sugg-1',
          message: 'They changed their number last month.',
          proposedValue: '+351 900 000 000',
        }),
      );
      expect(queue[1]).toEqual(
        expect.objectContaining({ id: 'sugg-2', proposedValue: null }),
      );
    });
  });
});
