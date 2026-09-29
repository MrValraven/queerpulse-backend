import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { MessagingService } from '../messaging/messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import { Listing } from './entities/listing.entity';
import { ListingClaimsService } from './listing-claims.service';
import { ListingOwnershipService } from './listing-ownership.service';

const now = new Date('2026-08-20T12:00:00.000Z');

// A listing submitted through the `suggest` path and still held by the
// platform (`ownerId` null) is unowned by `assertClaimable`'s own rules, so a
// claim on it never needs the `users` lookup.
const suggestedListing = {
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  name: 'Lux Café',
  ownerId: null,
  suggestedByUserId: null,
  path: 'suggest',
  badge: '',
} as Listing;

/** An admin-authored listing, exactly as `review`'s approve branch sees it:
 * unowned by `assertClaimable`'s rules (a null `ownerId`), and carrying
 * whatever `affirmingBaselineAcceptedAt` a test needs to exercise the two
 * outcomes of the stamp-on-approval guard. */
const listingForReview = (overrides: Partial<Listing> = {}): Listing =>
  ({
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'lux-cafe',
    name: 'Lux Café',
    ownerId: null,
    suggestedByUserId: null,
    path: 'suggest',
    badge: '',
    affirmingBaselineAcceptedAt: null,
    ...overrides,
  }) as Listing;

const claimFixture = (overrides: Partial<ListingClaim> = {}): ListingClaim =>
  ({
    id: 'claim-1',
    listingId: 'listing-1',
    claimantId: 'claimant-1',
    note: null,
    status: ListingClaimStatus.Pending,
    reviewedAt: null,
    reviewedBy: null,
    createdAt: now,
    ...overrides,
  }) as ListingClaim;

describe('ListingClaimsService', () => {
  let service: ListingClaimsService;
  let listings: { findOne: jest.Mock };
  let users: { findOne: jest.Mock };
  let claims: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
  };
  let adminQueueNotifications: { announce: jest.Mock };
  let ownership: {
    transferOwnership: jest.Mock;
    emitTransferChanges: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  /** What the shared transfer hands back, including the mailbox changes it
   * held back for this service to send after commit. */
  const transferResult = () => ({
    previousOwnerId: null,
    revokedCoManagerCount: 0,
    seatChanges: {
      endedSeats: [],
      releasedClaims: [],
      staffingChanges: [
        {
          identityId: 'listing-identity-1',
          userId: 'claimant-1',
          isStaff: true,
        },
      ],
    },
  });

  /** `review` reaches both repositories through the transaction's manager,
   * routed to the same doubles the plain-path tests already use, mirroring
   * `ListingOwnerOffersService`'s spec precedent for the same shape. */
  const transactionManager = () => ({
    getRepository: jest.fn((entity: unknown) =>
      entity === Listing ? listings : claims,
    ),
  });

  beforeEach(async () => {
    listings = { findOne: jest.fn().mockResolvedValue(suggestedListing) };
    users = { findOne: jest.fn().mockResolvedValue(null) };
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
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    ownership = {
      transferOwnership: jest.fn().mockResolvedValue(transferResult()),
      emitTransferChanges: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (manager: EntityManager) => Promise<unknown>) =>
          work(transactionManager() as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingClaimsService,
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingClaim), useValue: claims },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: MessagingService, useValue: { deliverEnquiry: jest.fn() } },
        // `review` hands the whole transfer to this service, so the suite
        // only needs a stand-in that the module can resolve.
        { provide: ListingOwnershipService, useValue: ownership },
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
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        ownerId: 'owner-1',
      });

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

    // Review Focus 1: a suggester who later claims their own suggestion.
    // The row is held by the platform with `ownerId` null and the suggester
    // recorded only in `suggestedByUserId`, which the self-claim guard never
    // reads, so "suggester === claimant" is accepted rather than refused.
    it('accepts a claim by the member who suggested the listing', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        ownerId: null,
        suggestedByUserId: 'claimant-1',
      });

      const result = await service.requestClaim('QPL-2026-0001', 'claimant-1');

      expect(result.id).toBe('claim-1');
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ListingClaims,
        'claim-1',
      );
    });

    it('accepts a claim on a suggestion the platform still holds', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        ownerId: null,
        suggestedByUserId: 'suggester-1',
      });

      const result = await service.requestClaim('QPL-2026-0001', 'claimant-1');

      expect(result.id).toBe('claim-1');
      expect(users.findOne).not.toHaveBeenCalled();
    });

    // An accepted admin owner offer seats a member on a suggestion without
    // writing any claim row, so only the `ownerId` shows it has an owner now.
    it('refuses a claim on a suggestion a member took through an owner offer', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        ownerId: 'offer-accepter',
        suggestedByUserId: 'suggester-1',
      });
      users.findOne.mockResolvedValue({
        id: 'offer-accepter',
        isSystem: false,
      });

      await expect(
        service.requestClaim('QPL-2026-0001', 'claimant-1'),
      ).rejects.toThrow('This listing already has an owner');
      expect(claims.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    // `badge === 'friendly'` describes the business (LGBTQ+ friendly as
    // opposed to queer-owned), and a real owner picks it for their own
    // listing. Ownership is read from `ownerId` alone.
    it('refuses a claim on an owned friendly listing with the owned-listing error', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        path: 'claim',
        badge: 'friendly',
        ownerId: 'friendly-owner',
      });
      users.findOne.mockResolvedValue({
        id: 'friendly-owner',
        isSystem: false,
      });

      await expect(
        service.requestClaim('QPL-2026-0001', 'claimant-1'),
      ).rejects.toThrow('This listing already has an owner');
      expect(claims.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('accepts a claim on a friendly listing that has no owner', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        path: 'claim',
        badge: 'friendly',
        ownerId: null,
      });

      const result = await service.requestClaim('QPL-2026-0001', 'claimant-1');

      expect(result.id).toBe('claim-1');
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('accepts a claim on a listing parked on a system account', async () => {
      listings.findOne.mockResolvedValue({
        ...suggestedListing,
        path: 'claim',
        badge: 'owned',
        ownerId: 'house-account',
      });
      users.findOne.mockResolvedValue({ id: 'house-account', isSystem: true });

      const result = await service.requestClaim('QPL-2026-0001', 'claimant-1');

      expect(result.id).toBe('claim-1');
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.ListingClaims,
        'claim-1',
      );
    });
  });

  // The Critical whole-branch-review finding: a member could become the
  // owner of an admin-authored listing without ever accepting the affirming
  // baseline, because the field stayed null on that listing forever and
  // `transferOwnership` never touches it. These two cases pin the fix at the
  // one site allowed to set it from a claim.
  describe('review', () => {
    it('stamps the affirming baseline when the listing has never carried one', async () => {
      const listing = listingForReview({ affirmingBaselineAcceptedAt: null });
      const claim = claimFixture();
      listings.findOne.mockResolvedValue(listing);
      claims.findOne.mockResolvedValue(claim);

      await service.review('claim-1', 'reviewer-1', 'approved');

      expect(listing.affirmingBaselineAcceptedAt).toBeInstanceOf(Date);
      // Stamped BEFORE the shared transfer, because the transfer is what
      // saves the listing row: the helper is handed this same object, so the
      // stamp travels to the database with the reassignment.
      expect(ownership.transferOwnership).toHaveBeenCalledWith(
        expect.anything(),
        listing,
        claim.claimantId,
        'reviewer-1',
        expect.any(String),
        listing.affirmingBaselineAcceptedAt,
      );
    });

    it('leaves an existing stamp untouched on approval', async () => {
      const existingStamp = new Date('2026-01-01T00:00:00.000Z');
      const listing = listingForReview({
        affirmingBaselineAcceptedAt: existingStamp,
      });
      const claim = claimFixture();
      listings.findOne.mockResolvedValue(listing);
      claims.findOne.mockResolvedValue(claim);

      await service.review('claim-1', 'reviewer-1', 'approved');

      // Somebody already made this promise (a prior claim or owner offer).
      // A second claim re-affirms it; it must never rewrite when.
      expect(listing.affirmingBaselineAcceptedAt).toBe(existingStamp);
    });

    it('does not stamp anything on a decline', async () => {
      const listing = listingForReview({ affirmingBaselineAcceptedAt: null });
      const claim = claimFixture();
      listings.findOne.mockResolvedValue(listing);
      claims.findOne.mockResolvedValue(claim);

      await service.review('claim-1', 'reviewer-1', 'declined');

      expect(listing.affirmingBaselineAcceptedAt).toBeNull();
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
      expect(ownership.emitTransferChanges).not.toHaveBeenCalled();
    });

    it('reads the listing under a pessimistic write lock before the transfer saves it', async () => {
      listings.findOne.mockResolvedValue(listingForReview());
      claims.findOne.mockResolvedValue(claimFixture());

      await service.review('claim-1', 'reviewer-1', 'approved');

      // The transfer saves the listing entity whole, so a staff edit that
      // committed after an unlocked read would be written over.
      expect(listings.findOne).toHaveBeenCalledWith({
        where: { id: claimFixture().listingId },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('emits the transfer changes once, after the approval commits', async () => {
      listings.findOne.mockResolvedValue(listingForReview());
      claims.findOne.mockResolvedValue(claimFixture());
      let wasEmittedBeforeCommit = false;
      dataSource.transaction.mockImplementation(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          const value = await work(
            transactionManager() as unknown as EntityManager,
          );
          wasEmittedBeforeCommit =
            ownership.emitTransferChanges.mock.calls.length > 0;
          return value;
        },
      );

      await service.review('claim-1', 'reviewer-1', 'approved');

      expect(wasEmittedBeforeCommit).toBe(false);
      expect(ownership.emitTransferChanges).toHaveBeenCalledTimes(1);
      expect(ownership.emitTransferChanges).toHaveBeenCalledWith(
        transferResult(),
      );
    });

    it('emits nothing when the approval commit fails', async () => {
      // The callback runs to the end, transfer included, and then the commit
      // throws, so this proves no emission rides inside the transaction.
      listings.findOne.mockResolvedValue(listingForReview());
      claims.findOne.mockResolvedValue(claimFixture());
      dataSource.transaction.mockImplementation(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          await work(transactionManager() as unknown as EntityManager);
          throw new Error('commit failed');
        },
      );

      await expect(
        service.review('claim-1', 'reviewer-1', 'approved'),
      ).rejects.toThrow('commit failed');
      expect(ownership.transferOwnership).toHaveBeenCalledTimes(1);
      expect(ownership.emitTransferChanges).not.toHaveBeenCalled();
    });

    it('emits nothing when a concurrent reviewer wins and the transfer rolls back', async () => {
      listings.findOne.mockResolvedValue(listingForReview());
      claims.findOne.mockResolvedValue(claimFixture());
      claims.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.review('claim-1', 'reviewer-1', 'approved'),
      ).rejects.toThrow('This claim has already been reviewed');
      expect(ownership.transferOwnership).toHaveBeenCalledTimes(1);
      expect(ownership.emitTransferChanges).not.toHaveBeenCalled();
    });
  });
});
