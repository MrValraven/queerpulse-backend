import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
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
import { ListingModerationEvent } from './entities/listing-moderation-event.entity';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { Profile } from '../users/entities/profile.entity';

describe('ListingEditSuggestionsService', () => {
  let service: ListingEditSuggestionsService;
  let listings: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock<Promise<Partial<Listing>>, [Partial<Listing>]>;
    manager: { transaction: jest.Mock };
  };
  let moderationEvents: { save: jest.Mock };
  let suggestions: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    listings = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((listing: Partial<Listing>) => Promise.resolve(listing)),
      // An applied correction saves the listing and its history row in one
      // transaction. The stub runs the callback with a manager whose
      // `withRepository` hands back the same mock, so `listings.save` still
      // observes the write.
      manager: {
        transaction: jest.fn(
          (work: (manager: { withRepository: jest.Mock }) => Promise<void>) =>
            work({
              withRepository: jest.fn((repository: unknown) => repository),
            }),
        ),
      },
    };
    moderationEvents = { save: jest.fn().mockResolvedValue(undefined) };
    suggestions = {
      create: jest.fn((input: Partial<ListingEditSuggestion>) => input),
      save: jest.fn(),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    profiles = { find: jest.fn() };
    notifications = { create: jest.fn() };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingEditSuggestionsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        {
          provide: getRepositoryToken(ListingEditSuggestion),
          useValue: suggestions,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: getRepositoryToken(ListingModerationEvent),
          useValue: moderationEvents,
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
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

      // Mirrors `DirectoryService.loadLiveOr404`: an owner-paused listing has
      // no public detail page, so it cannot receive a suggestion either.
      expect(listings.findOne).toHaveBeenCalledWith({
        where: {
          slug: 'galeria-lume',
          status: ListingStatus.Live,
          isHiddenByOwner: false,
        },
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

    it('tells the edit-suggestion queue with the saved row id', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      await service.submit('galeria-lume', 'member-1', dto);

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ListingEditSuggestions,
        'sugg-1',
      );
    });

    it('tells nobody when the suggestion is refused as a self-suggestion', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'galeria-lume',
        ownerId: 'owner-1',
      });

      await expect(
        service.submit('galeria-lume', 'owner-1', dto),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
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

    it('refuses an address suggestion for an online-only listing', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'fio-rosa',
        ownerId: 'owner-1',
        online: true,
      });

      await expect(
        service.submit('fio-rosa', 'member-1', {
          field: 'address',
          message: 'They have a shop on Rua X now.',
        }),
      ).rejects.toThrow(
        'This business is online only, so it has no address to correct.',
      );
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('still takes an hours suggestion for an online-only listing', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'fio-rosa',
        ownerId: 'owner-1',
        online: true,
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      await expect(
        service.submit('fio-rosa', 'member-1', {
          field: 'hours',
          message: 'Orders ship on Mondays only.',
        }),
      ).resolves.toEqual({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });
    });

    it('refuses an address suggestion for a mobile listing with no meeting point', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'corte-movel',
        ownerId: 'owner-1',
        online: false,
        mobile: true,
        latitude: null,
        longitude: null,
      });

      await expect(
        service.submit('corte-movel', 'member-1', {
          field: 'address',
          message: 'They opened a salon on Rua X.',
        }),
      ).rejects.toThrow(
        'This business works out and about with no meeting point, so it has no address to correct.',
      );
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('takes an address suggestion for a mobile listing that meets people at a set spot', async () => {
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        slug: 'lisboa-a-pe',
        ownerId: 'owner-1',
        online: false,
        mobile: true,
        latitude: 38.7075,
        longitude: -9.1364,
      });
      suggestions.save.mockResolvedValue({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });

      await expect(
        service.submit('lisboa-a-pe', 'member-1', {
          field: 'address',
          message: 'The walk starts at the Arco da Rua Augusta now.',
        }),
      ).resolves.toEqual({
        id: 'sugg-1',
        status: ListingEditSuggestionStatus.Pending,
      });
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

    it('writes an accepted hours correction for an online-only listing into its reply note', async () => {
      const correction = `Orders ship on Mondays. ${'x'.repeat(200)}`;
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-online-hours',
        listingId: 'listing-1',
        field: 'hours',
        message: correction,
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        hoursNote: 'Old note',
        onlineDetails: {
          mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
        },
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-online-hours', 'mod-1', {
        status: 'accepted',
      });

      const [savedListing] = listings.save.mock.calls[0] as [Listing];
      expect(savedListing.hoursNote).toBe('Old note');
      expect(savedListing.onlineDetails.replyNote).toBe(
        Array.from(correction).slice(0, 140).join(''),
      );
      expect(savedListing.onlineDetails.mainLink).toEqual({
        url: 'https://fiorosa.pt',
        kind: 'shop',
      });
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({
          changedFields: ['onlineDetails'],
          reason:
            'A moderator applied a suggested correction to the reply and dispatch note.',
        }),
      );
    });

    it('still writes an accepted hours correction for a place into its hours note', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-place-hours',
        listingId: 'listing-1',
        field: 'hours',
        message: 'Closed on Mondays',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'galeria-lume',
        online: false,
        hoursNote: 'Old note',
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-place-hours', 'mod-1', {
        status: 'accepted',
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ hoursNote: 'Closed on Mondays' }),
      );
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({ changedFields: ['hoursNote'] }),
      );
    });

    it('resolves an accepted address suggestion for a listing now online only without writing an address', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-online-address',
        listingId: 'listing-1',
        field: 'address',
        message: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        address: '',
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      const result = await service.resolve('sugg-online-address', 'mod-1', {
        status: 'accepted',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Accepted);
      expect(listings.save).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        'listing_edit_suggestion_accepted',
        { source: 'listing', listingSlug: 'fio-rosa', field: 'address' },
      );
    });

    it('refuses a moderator address value for a listing now online only, before resolving the row', async () => {
      const suggestion = {
        id: 'sugg-online-address-value',
        listingId: 'listing-1',
        field: 'address',
        message: 'They moved.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        address: '',
      });

      await expect(
        service.resolve('sugg-online-address-value', 'mod-1', {
          status: 'accepted',
          value: '123 New Street',
        }),
      ).rejects.toThrow(
        'This business is online only, so it has no address to correct.',
      );
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Pending);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('resolves an accepted address suggestion for a mobile listing with no meeting point without writing an address', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-mobile-address',
        listingId: 'listing-1',
        field: 'address',
        message: '123 New Street',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ref: 'QPL-2026-0042',
        ownerId: 'owner-1',
        slug: 'corte-movel',
        online: false,
        mobile: true,
        latitude: null,
        longitude: null,
        address: '',
      });

      const result = await service.resolve('sugg-mobile-address', 'mod-1', {
        status: 'accepted',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Accepted);
      expect(listings.save).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        'listing_edit_suggestion_accepted',
        { source: 'listing', listingSlug: 'corte-movel', field: 'address' },
      );
    });

    it('refuses a moderator address value for a mobile listing with no meeting point, before resolving the row', async () => {
      const suggestion = {
        id: 'sugg-mobile-address-value',
        listingId: 'listing-1',
        field: 'address',
        message: 'They have a salon now.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'corte-movel',
        online: false,
        mobile: true,
        latitude: null,
        longitude: null,
        address: '',
      });

      await expect(
        service.resolve('sugg-mobile-address-value', 'mod-1', {
          status: 'accepted',
          value: '123 New Street',
        }),
      ).rejects.toThrow(
        'This business works out and about with no meeting point, so it has no address to correct.',
      );
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Pending);
    });

    it('writes an accepted address correction onto the meeting point of a mobile listing', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-meeting-point',
        listingId: 'listing-1',
        field: 'address',
        message: 'Arco da Rua Augusta',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'lisboa-a-pe',
        online: false,
        mobile: true,
        latitude: 38.7075,
        longitude: -9.1364,
        address: 'Praça do Comércio',
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-meeting-point', 'mod-1', {
        status: 'accepted',
      });

      expect(listings.save).toHaveBeenCalledWith(
        expect.objectContaining({ address: 'Arco da Rua Augusta' }),
      );
    });

    it('writes an accepted website correction for an online-only listing into its main link, keeping the kind', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-online-website',
        listingId: 'listing-1',
        field: 'website',
        message: 'Their shop moved.',
        proposedValue: 'fiorosa.shop',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        onlineDetails: {
          mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
          replyNote: 'Replies within a day.',
        },
        social: {
          phone: '',
          website: 'fiorosa.pt',
          email: '',
          instagram: 'fiorosa',
        },
      });

      await service.resolve('sugg-online-website', 'mod-1', {
        status: 'accepted',
      });

      const [savedListing] = listings.save.mock.calls[0] as [Listing];
      expect(savedListing.onlineDetails.mainLink).toEqual({
        url: 'https://fiorosa.shop',
        kind: 'shop',
      });
      expect(savedListing.onlineDetails.replyNote).toBe(
        'Replies within a day.',
      );
      expect(savedListing.social).toEqual(
        expect.objectContaining({
          website: 'fiorosa.shop',
          instagram: 'fiorosa',
        }),
      );
      expect(moderationEvents.save).toHaveBeenCalledWith(
        expect.objectContaining({
          changedFields: ['onlineDetails', 'social'],
          reason:
            'A moderator applied a suggested correction to the main link and the website.',
        }),
      );
    });

    it('gives an online-only listing with no main link a website main link from an accepted correction', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-online-website-new',
        listingId: 'listing-1',
        field: 'website',
        message: 'https://fiorosa.pt',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        onlineDetails: {},
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-online-website-new', 'mod-1', {
        status: 'accepted',
      });

      const [savedListing] = listings.save.mock.calls[0] as [Listing];
      expect(savedListing.onlineDetails.mainLink).toEqual({
        url: 'https://fiorosa.pt',
        kind: 'website',
      });
    });

    it('resolves an accepted website correction the main link cannot hold without writing anything', async () => {
      suggestions.findOne.mockResolvedValue({
        id: 'sugg-online-website-bad',
        listingId: 'listing-1',
        field: 'website',
        message: 'Their site is fiorosa now.',
        proposedValue: 'fiorosa',
        status: ListingEditSuggestionStatus.Pending,
      });
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        onlineDetails: {
          mainLink: { url: 'https://fiorosa.pt', kind: 'shop' },
        },
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      const result = await service.resolve('sugg-online-website-bad', 'mod-1', {
        status: 'accepted',
      });

      expect(result.status).toBe(ListingEditSuggestionStatus.Accepted);
      expect(listings.save).not.toHaveBeenCalled();
      expect(moderationEvents.save).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        'listing_edit_suggestion_accepted',
        { source: 'listing', listingSlug: 'fio-rosa', field: 'website' },
      );
    });

    it('refuses a moderator website value the main link of an online-only listing cannot hold, before resolving the row', async () => {
      const suggestion = {
        id: 'sugg-online-website-value',
        listingId: 'listing-1',
        field: 'website',
        message: 'Their site moved.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
      });

      await expect(
        service.resolve('sugg-online-website-value', 'mod-1', {
          status: 'accepted',
          value: 'fiorosa',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Pending);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('refuses a moderator hours value over 140 characters for an online-only listing, before resolving the row', async () => {
      const suggestion = {
        id: 'sugg-online-hours-value',
        listingId: 'listing-1',
        field: 'hours',
        message: 'They dispatch on Mondays now.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
      });

      await expect(
        service.resolve('sugg-online-hours-value', 'mod-1', {
          status: 'accepted',
          value: 'é'.repeat(141),
        }),
      ).rejects.toThrow(
        'This business is online only, so an hours correction becomes its reply and dispatch note, which holds at most 140 characters.',
      );
      expect(suggestions.save).not.toHaveBeenCalled();
      expect(suggestion.status).toBe(ListingEditSuggestionStatus.Pending);
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('takes a moderator hours value of 140 characters for an online-only listing', async () => {
      const suggestion = {
        id: 'sugg-online-hours-fits',
        listingId: 'listing-1',
        field: 'hours',
        message: 'They dispatch on Mondays now.',
        status: ListingEditSuggestionStatus.Pending,
      };
      suggestions.findOne.mockResolvedValue(suggestion);
      suggestions.save.mockImplementation((row) => Promise.resolve(row));
      listings.findOne.mockResolvedValue({
        id: 'listing-1',
        ownerId: 'owner-1',
        slug: 'fio-rosa',
        online: true,
        hoursNote: '',
        onlineDetails: {},
        social: { phone: '', website: '', email: '', instagram: '' },
      });

      await service.resolve('sugg-online-hours-fits', 'mod-1', {
        status: 'accepted',
        value: 'é'.repeat(140),
      });

      const [savedListing] = listings.save.mock.calls[0] as [Listing];
      expect(savedListing.onlineDetails.replyNote).toBe('é'.repeat(140));
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
