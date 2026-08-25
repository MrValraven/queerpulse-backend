import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from './entities/listing-co-manager.entity';
import { ListingModerationAction } from './entities/listing-moderation-event.entity';
import { Listing } from './entities/listing.entity';
import { ListingCoManagersService } from './listing-co-managers.service';

/**
 * The seat lifecycle and the owner-only rules around it: who may invite, who
 * must consent, who may take a seat back, and what the listing's history
 * records.
 *
 * The other half of this boundary — what a seat actually lets someone do, and
 * the owner-personal fields it does not — lives in
 * `listing-co-manager-permissions.spec.ts`.
 */

const OWNER_ID = 'owner-1';
const INVITEE_ID = 'invitee-1';
const LISTING = {
  id: 'listing-1',
  ref: 'QPL-2026-0001',
  slug: 'lux-cafe',
  name: 'Lux Café',
  ownerId: OWNER_ID,
} as Listing;

const seat = (overrides: Partial<ListingCoManager> = {}): ListingCoManager =>
  ({
    id: 'seat-1',
    listingId: 'listing-1',
    userId: INVITEE_ID,
    invitedByUserId: OWNER_ID,
    status: ListingCoManagerStatus.Invited,
    invitedAt: new Date('2026-01-01T00:00:00.000Z'),
    acceptedAt: null,
    endedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as ListingCoManager;

describe('ListingCoManagersService', () => {
  let service: ListingCoManagersService;
  let coManagers: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let listings: { find: jest.Mock; findOne: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let notifications: { create: jest.Mock };
  let transactionManager: {
    save: jest.Mock;
    getRepository: jest.Mock;
  };

  /** `MemberLookup.userIdForSlug` joins on `users.status = 'active'`, so this
   * stub is also where "only existing ACTIVE members can be invited" is
   * modelled: an inactive member simply has no row to return. */
  const slugResolvesTo = (slug: string, userId: string) =>
    profiles.createQueryBuilder.mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ slug, userId }]),
    });

  const slugResolvesToNobody = () =>
    profiles.createQueryBuilder.mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    });

  beforeEach(async () => {
    coManagers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: object) =>
        Promise.resolve({ id: 'seat-1', ...value }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    listings = {
      find: jest.fn().mockResolvedValue([LISTING]),
      findOne: jest.fn().mockResolvedValue(LISTING),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    slugResolvesToNobody();
    notifications = { create: jest.fn().mockResolvedValue(null) };
    transactionManager = {
      save: jest.fn((first: unknown, second?: object) =>
        Promise.resolve(
          second !== undefined ? { id: 'event-1', ...second } : first,
        ),
      ),
      getRepository: jest.fn((entity: unknown) =>
        entity === Listing ? listings : coManagers,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingCoManagersService,
        { provide: getRepositoryToken(ListingCoManager), useValue: coManagers },
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(
              (work: (manager: EntityManager) => Promise<unknown>) =>
                work(transactionManager as unknown as EntityManager),
            ),
          },
        },
      ],
    }).compile();
    service = module.get(ListingCoManagersService);
  });

  describe('invite', () => {
    beforeEach(() => slugResolvesTo('mika', INVITEE_ID));

    it('is OWNER ONLY: a co-manager cannot grow the team around the owner', async () => {
      // `loadOwnedOr404` folds ownership into the query, so a non-owner gets no
      // row and a 404 rather than a 403 confirming the ref.
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.invite('QPL-2026-0001', 'co-manager-1', { memberSlug: 'mika' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(coManagers.save).not.toHaveBeenCalled();
    });

    it('creates the seat as INVITED, granting nothing yet', async () => {
      await service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' });

      expect(coManagers.save).toHaveBeenCalledWith(
        expect.objectContaining({
          listingId: 'listing-1',
          userId: INVITEE_ID,
          invitedByUserId: OWNER_ID,
          status: ListingCoManagerStatus.Invited,
          acceptedAt: null,
          endedAt: null,
        }),
      );
    });

    it('notifies the invited member', async () => {
      await service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' });

      expect(notifications.create).toHaveBeenCalledWith(
        INVITEE_ID,
        NotificationType.ListingCoManagerInvite,
        expect.objectContaining({
          listingSlug: 'lux-cafe',
          listingName: 'Lux Café',
        }),
        OWNER_ID,
      );
    });

    it('never lets a failed notification undo a committed invitation', async () => {
      notifications.create.mockRejectedValue(new Error('bell is down'));

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' }),
      ).resolves.toBeDefined();
    });

    it('refuses an unknown or inactive member', async () => {
      slugResolvesToNobody();

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'ghost' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses the owner inviting themselves', async () => {
      slugResolvesTo('ana', OWNER_ID);

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'ana' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a second invitation to someone who already holds a seat', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a second invitation while the first is unanswered', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses once the listing is at its cap', async () => {
      coManagers.count.mockResolvedValue(
        ListingCoManagersService.MAX_CO_MANAGERS_PER_LISTING,
      );

      await expect(
        service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('counts unanswered invitations toward the cap', async () => {
      await service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' });

      const [countArguments] = coManagers.count.mock.calls[0] as [
        { where?: { listingId?: string; status?: unknown } },
      ];
      expect(countArguments?.where?.listingId).toBe('listing-1');
      // The status filter is what makes an unanswered invitation occupy a seat.
      expect(countArguments?.where?.status).toBeDefined();
    });

    it('re-invites a member who previously declined by reusing their row', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({
          status: ListingCoManagerStatus.Declined,
          endedAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      );

      await service.invite('QPL-2026-0001', OWNER_ID, { memberSlug: 'mika' });

      // Every field describing the seat that ended is rewritten, so nothing
      // from it can be read back as belonging to this invitation.
      expect(coManagers.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'seat-1',
          status: ListingCoManagerStatus.Invited,
          acceptedAt: null,
          endedAt: null,
        }),
      );
    });
  });

  describe('respondToInvite', () => {
    it('accepting activates the seat and records it in the listing history', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      expect(coManagers.update).toHaveBeenCalledWith(
        { id: 'seat-1', status: ListingCoManagerStatus.Invited },
        expect.objectContaining({ status: ListingCoManagerStatus.Active }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          listingId: 'listing-1',
          actorId: INVITEE_ID,
          action: ListingModerationAction.CoManagerAdded,
        }),
      );
    });

    it('declining ends the seat and writes NO history row', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'decline');

      expect(coManagers.update).toHaveBeenCalledWith(
        { id: 'seat-1', status: ListingCoManagerStatus.Invited },
        expect.objectContaining({ status: ListingCoManagerStatus.Declined }),
      );
      // Nothing was ever granted, so there is nothing for the audit trail to
      // record losing.
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    it('tells the owner either way', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');
      expect(notifications.create).toHaveBeenCalledWith(
        OWNER_ID,
        NotificationType.ListingCoManagerInviteAccepted,
        expect.objectContaining({ listingName: 'Lux Café' }),
        INVITEE_ID,
      );

      notifications.create.mockClear();
      coManagers.findOne.mockResolvedValue(seat());
      await service.respondToInvite('seat-1', INVITEE_ID, 'decline');
      expect(notifications.create).toHaveBeenCalledWith(
        OWNER_ID,
        NotificationType.ListingCoManagerInviteDeclined,
        expect.anything(),
        INVITEE_ID,
      );
    });

    it('404s an invitation addressed to somebody else', async () => {
      // Scoped by `{ id, userId }`, so a seat id is never an oracle for "is
      // this a real invitation".
      coManagers.findOne.mockResolvedValue(null);

      await expect(
        service.respondToInvite('seat-1', 'not-the-invitee', 'accept'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s an invitation that has already been answered', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await expect(
        service.respondToInvite('seat-1', INVITEE_ID, 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when a concurrent answer won the conditional update', async () => {
      coManagers.findOne.mockResolvedValue(seat());
      coManagers.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.respondToInvite('seat-1', INVITEE_ID, 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('revoke', () => {
    beforeEach(() => slugResolvesTo('mika', INVITEE_ID));

    it('is OWNER ONLY', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.revoke('QPL-2026-0001', 'co-manager-1', 'mika'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(coManagers.update).not.toHaveBeenCalled();
    });

    it('ends an active seat and records the removal in the listing history', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(coManagers.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seat-1' }),
        expect.objectContaining({ status: ListingCoManagerStatus.Revoked }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: OWNER_ID,
          action: ListingModerationAction.CoManagerRemoved,
        }),
      );
    });

    it('withdraws an unanswered invitation without writing a history row', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(coManagers.update).toHaveBeenCalled();
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    it('404s a seat that has already ended, so a double-click writes one event', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Revoked }),
      );

      await expect(
        service.revoke('QPL-2026-0001', OWNER_ID, 'mika'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('leave', () => {
    it('lets a co-manager step down, recorded as their own act', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await service.leave('QPL-2026-0001', INVITEE_ID);

      expect(coManagers.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seat-1' }),
        expect.objectContaining({ status: ListingCoManagerStatus.Left }),
      );
      expect(transactionManager.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorId: INVITEE_ID,
          action: ListingModerationAction.CoManagerRemoved,
        }),
      );
    });

    it('404s a member who holds no seat on the listing', async () => {
      coManagers.findOne.mockResolvedValue(null);

      await expect(
        service.leave('QPL-2026-0001', 'nobody'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listSeats', () => {
    it('is readable by an active co-manager, not only the owner', async () => {
      // Reading is not managing. Someone who can already edit the page needs to
      // know who else can; inviting and revoking stay owner-only.
      coManagers.count.mockResolvedValue(1);

      await expect(
        service.listSeats('QPL-2026-0001', 'co-manager-1'),
      ).resolves.toEqual([]);
    });

    it('404s a stranger rather than confirming the ref', async () => {
      coManagers.count.mockResolvedValue(0);

      await expect(
        service.listSeats('QPL-2026-0001', 'stranger-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revokeAllForOwnershipTransfer', () => {
    it('clears every live seat and reports the count', async () => {
      coManagers.update.mockResolvedValue({ affected: 3 });

      const revoked = await service.revokeAllForOwnershipTransfer(
        transactionManager as unknown as EntityManager,
        'listing-1',
        new Date('2026-03-01T00:00:00.000Z'),
      );

      expect(revoked).toBe(3);
      expect(coManagers.update).toHaveBeenCalledWith(
        expect.objectContaining({ listingId: 'listing-1' }),
        expect.objectContaining({ status: ListingCoManagerStatus.Revoked }),
      );
    });

    it('reports zero rather than undefined when the driver omits affected', async () => {
      coManagers.update.mockResolvedValue({});

      await expect(
        service.revokeAllForOwnershipTransfer(
          transactionManager as unknown as EntityManager,
          'listing-1',
          new Date(),
        ),
      ).resolves.toBe(0);
    });
  });

  describe('isActiveCoManager', () => {
    it('an unanswered invitation is not access', async () => {
      await service.isActiveCoManager('listing-1', INVITEE_ID);

      expect(coManagers.count).toHaveBeenCalledWith({
        where: {
          listingId: 'listing-1',
          userId: INVITEE_ID,
          status: ListingCoManagerStatus.Active,
        },
      });
    });
  });
});
