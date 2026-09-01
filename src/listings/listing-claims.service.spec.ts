import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { ListingClaim } from './entities/listing-claim.entity';
import { Listing } from './entities/listing.entity';
import { ListingClaimsService } from './listing-claims.service';
import { ListingCoManagersService } from './listing-co-managers.service';

const now = new Date('2026-08-20T12:00:00.000Z');

// A listing submitted through the `suggest` path is unowned by
// `assertClaimable`'s own rules, so a claim on it never needs the `users`
// lookup this suite otherwise has no reason to exercise.
const suggestedListing = {
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  name: 'Lux Café',
  ownerId: 'owner-1',
  path: 'suggest',
  badge: '',
} as Listing;

describe('ListingClaimsService', () => {
  let service: ListingClaimsService;
  let listings: { findOne: jest.Mock };
  let claims: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(suggestedListing) };
    claims = {
      create: jest.fn((v: Partial<ListingClaim>) => v),
      save: jest.fn((v: Partial<ListingClaim>) =>
        Promise.resolve({
          id: 'claim-1',
          createdAt: now,
          reviewedAt: null,
          reviewedBy: null,
          ...v,
        } as ListingClaim),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingClaimsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingClaim), useValue: claims },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: MessagingService, useValue: { deliverEnquiry: jest.fn() } },
        { provide: ListingCoManagersService, useValue: {} },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(ListingClaimsService);
  });

  describe('requestClaim', () => {
    it('tells the listing-claim queue with the saved row id', async () => {
      const result = await service.requestClaim('QPL-2026-0001', 'claimant-1');

      expect(result.id).toBe('claim-1');
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ListingClaims,
        'claim-1',
      );
    });

    it('tells nobody when the claim is refused as a self-claim', async () => {
      await expect(
        service.requestClaim('QPL-2026-0001', 'owner-1'),
      ).rejects.toThrow('You already own this listing');
      expect(claims.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells nobody when the claim is never saved', async () => {
      claims.save.mockRejectedValue(new Error('write failed'));

      await expect(
        service.requestClaim('QPL-2026-0001', 'claimant-1'),
      ).rejects.toThrow('write failed');
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});
