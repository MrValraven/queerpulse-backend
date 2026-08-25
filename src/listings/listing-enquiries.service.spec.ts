import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MessagingService } from '../messaging/messaging.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { ListingEnquiry } from './entities/listing-enquiry.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { ListingEnquiriesService } from './listing-enquiries.service';

const baseListing = (overrides: Partial<Listing> = {}): Listing =>
  ({
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'drama-bar',
    name: 'Drama Bar',
    ownerId: 'owner-1',
    status: ListingStatus.Live,
    path: 'own',
    badge: 'owned',
    isHiddenByOwner: false,
    ...overrides,
  }) as Listing;

const activeOwner = {
  id: 'owner-1',
  isSystem: false,
  status: UserStatus.Active,
};

describe('ListingEnquiriesService', () => {
  let service: ListingEnquiriesService;
  let listings: { findOne: jest.Mock };
  let enquiries: {
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let messaging: {
    enquiryContactability: jest.Mock;
    deliverEnquiry: jest.Mock;
  };
  let contentModeration: { statesForAnyType: jest.Mock };

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(baseListing()) };
    enquiries = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<ListingEnquiry>) => value),
      save: jest.fn((value: Partial<ListingEnquiry>) =>
        Promise.resolve({ id: 'enquiry-1', ...value }),
      ),
    };
    users = { findOne: jest.fn().mockResolvedValue(activeOwner) };
    messaging = {
      enquiryContactability: jest.fn().mockResolvedValue({
        canDeliver: true,
        blockedReason: null,
        replyRequiresConnection: true,
      }),
      deliverEnquiry: jest
        .fn()
        .mockResolvedValue({ conversationId: 'conversation-1' }),
    };
    contentModeration = { statesForAnyType: jest.fn(() => new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingEnquiriesService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingEnquiry), useValue: enquiries },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: MessagingService, useValue: messaging },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
      ],
    }).compile();

    service = module.get(ListingEnquiriesService);
  });

  describe('getContact', () => {
    it('offers the contact route on a claimed, live listing', async () => {
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toEqual({
        canMessageOwner: true,
        unavailableReason: null,
        replyRequiresConnection: true,
        existingConversationId: null,
      });
    });

    it('deep-links a thread the member already started', async () => {
      enquiries.findOne.mockResolvedValue({
        id: 'enquiry-0',
        conversationId: 'conversation-9',
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.existingConversationId).toBe('conversation-9');
    });

    // The `friendly`/`suggested` paths carry a non-null owner_id belonging to
    // whoever recommended the place, not to the business.
    it('refuses a suggested listing rather than messaging whoever suggested it', async () => {
      listings.findOne.mockResolvedValue(baseListing({ path: 'suggest' }));
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject({
        canMessageOwner: false,
        unavailableReason: 'unclaimed',
      });
      expect(messaging.enquiryContactability).not.toHaveBeenCalled();
    });

    it('refuses a friendly recommendation for the same reason', async () => {
      listings.findOne.mockResolvedValue(baseListing({ badge: 'friendly' }));
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('unclaimed');
    });

    it('refuses a listing parked on a platform account', async () => {
      users.findOne.mockResolvedValue({ ...activeOwner, isSystem: true });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('refuses a listing whose owner account was erased', async () => {
      users.findOne.mockResolvedValue(null);
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('refuses a listing whose owner is suspended', async () => {
      users.findOne.mockResolvedValue({
        ...activeOwner,
        status: UserStatus.Suspended,
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact.unavailableReason).toBe('no_owner_account');
    });

    it('tells the owner it is their own listing', async () => {
      const contact = await service.getContact('drama-bar', 'owner-1');
      expect(contact.unavailableReason).toBe('own_listing');
    });

    // Reported without direction, so the endpoint cannot be used to test
    // whether a particular person has blocked you.
    it('reports a block without saying which way it runs', async () => {
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
      });
      const contact = await service.getContact('drama-bar', 'member-1');
      expect(contact).toMatchObject({
        canMessageOwner: false,
        unavailableReason: 'unavailable',
      });
    });

    it('404s a listing under a moderator takedown, like the public page does', async () => {
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['drama-bar', { hidden: true, removed: false }]]),
      );
      await expect(service.getContact('drama-bar', 'member-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s a listing that is not live', async () => {
      listings.findOne.mockResolvedValue(null);
      await expect(service.getContact('drama-bar', 'member-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('send', () => {
    it('delivers through messaging and records the link to the listing', async () => {
      const result = await service.send('drama-bar', 'member-1', {
        body: 'Is the upstairs room step-free?',
      });

      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'member-1',
        'owner-1',
        expect.stringContaining('Drama Bar'),
      );
      // The member's own words survive the context header untouched.
      const [, , deliveredBody] = messaging.deliverEnquiry.mock.calls[0] as [
        string,
        string,
        string,
      ];
      expect(deliveredBody).toContain('Is the upstairs room step-free?');

      expect(enquiries.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 'listing-1',
          senderId: 'member-1',
          ownerId: 'owner-1',
          conversationId: 'conversation-1',
        }),
      );
      expect(result).toEqual({
        conversationId: 'conversation-1',
        enquiryId: 'enquiry-1',
        replyRequiresConnection: true,
      });
    });

    // The enquiry row holds no message text; messaging still owns storage.
    it('never writes the member’s words into its own table', async () => {
      await service.send('drama-bar', 'member-1', {
        body: 'Something personal I would not post in public.',
      });
      const saved = JSON.stringify(enquiries.save.mock.calls[0]?.[0] ?? {});
      expect(saved).not.toContain('Something personal');
    });

    it('sends the DM before writing its own row, so a retry cannot duplicate it', async () => {
      const order: string[] = [];
      messaging.deliverEnquiry.mockImplementation(() => {
        order.push('deliver');
        return Promise.resolve({ conversationId: 'conversation-1' });
      });
      enquiries.save.mockImplementation((value: Partial<ListingEnquiry>) => {
        order.push('record');
        return Promise.resolve({ id: 'enquiry-1', ...value });
      });

      await service.send('drama-bar', 'member-1', { body: 'A question here.' });

      expect(order).toEqual(['deliver', 'record']);
    });

    it('refuses an unclaimed listing with a 400 rather than opening a dead thread', async () => {
      listings.findOne.mockResolvedValue(baseListing({ path: 'suggest' }));
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('refuses when messaging says the two cannot be connected at all', async () => {
      messaging.enquiryContactability.mockResolvedValue({
        canDeliver: false,
        blockedReason: 'blocked',
        replyRequiresConnection: false,
      });
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(ForbiddenException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('429s the third enquiry to one business in a day', async () => {
      enquiries.count.mockResolvedValueOnce(3);
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(HttpException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('429s once the across-the-directory daily cap is hit', async () => {
      enquiries.count.mockResolvedValueOnce(0).mockResolvedValueOnce(20);
      await expect(
        service.send('drama-bar', 'member-1', { body: 'A question here.' }),
      ).rejects.toThrow(HttpException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });
  });
});
