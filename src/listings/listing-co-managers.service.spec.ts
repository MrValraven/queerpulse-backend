import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
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

const NO_MAILBOX_CHANGES = {
  endedSeats: [],
  releasedClaims: [],
  staffingChanges: [],
};

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
  let identities: { ensureIdentityFor: jest.Mock };
  let identityMailboxSync: {
    onStaffAdded: jest.Mock;
    onStaffRemoved: jest.Mock;
    emitSeatChanges: jest.Mock;
  };
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
    identities = {
      ensureIdentityFor: jest
        .fn()
        .mockResolvedValue({ id: 'listing-identity-1' }),
    };
    identityMailboxSync = {
      onStaffAdded: jest.fn().mockResolvedValue(NO_MAILBOX_CHANGES),
      onStaffRemoved: jest.fn().mockResolvedValue(NO_MAILBOX_CHANGES),
      emitSeatChanges: jest.fn(),
    };
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
        { provide: IdentitiesService, useValue: identities },
        { provide: IdentityMailboxSyncService, useValue: identityMailboxSync },
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

    it('reads the seat under a row lock, the lock a revoke or leave also takes', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      expect(coManagers.findOne).toHaveBeenCalledWith({
        where: { id: 'seat-1', userId: INVITEE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      // The locked read comes before the status flip.
      expect(coManagers.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        coManagers.update.mock.invocationCallOrder[0] ?? 0,
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

    it('seats the mailbox on accept, in the same transaction', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
        IdentityKind.Listing,
        'listing-1',
      );
      expect(identityMailboxSync.onStaffAdded).toHaveBeenCalledWith(
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
    });

    // Task 25: the new co-manager hears `mailbox:staffing` only once the
    // acceptance has committed.
    it('tells the new co-manager about their mailbox only after the transaction resolves', async () => {
      coManagers.findOne.mockResolvedValue(seat());
      const acceptedChanges = {
        ...NO_MAILBOX_CHANGES,
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: true,
          },
        ],
      };
      identityMailboxSync.onStaffAdded.mockImplementation(async () => {
        expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
        return acceptedChanges;
      });

      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledTimes(1);
      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        acceptedChanges,
      );
    });

    it('never tells anyone about a mailbox when the acceptance rolls back', async () => {
      coManagers.findOne.mockResolvedValue(seat());
      identityMailboxSync.onStaffAdded.mockResolvedValue({
        ...NO_MAILBOX_CHANGES,
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: true,
          },
        ],
      });
      // The callback runs to the end, seat included, and the commit fails.
      const dataSource = (
        service as unknown as { dataSource: { transaction: jest.Mock } }
      ).dataSource;
      dataSource.transaction.mockImplementationOnce(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          await work(transactionManager as unknown as EntityManager);
          throw new Error('commit failed');
        },
      );

      await expect(
        service.respondToInvite('seat-1', INVITEE_ID, 'accept'),
      ).rejects.toThrow('commit failed');

      expect(identityMailboxSync.onStaffAdded).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    it('tells nobody about a mailbox on decline', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'decline');

      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    it('does not touch the mailbox on decline, since nothing was ever granted', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.respondToInvite('seat-1', INVITEE_ID, 'decline');

      expect(identityMailboxSync.onStaffAdded).not.toHaveBeenCalled();
    });

    it('seats the mailbox on a returning co-manager who left and was invited again, calling onStaffAdded both times', async () => {
      // A returning co-manager's `listing_co_managers` row is REUSED
      // (`inviteToLoadedListing`'s terminal-row reuse), so the same seat id
      // answers a second invitation. `onStaffAdded` firing twice for the same
      // identity/user is exactly what its own idempotent reactivation is for
      // (see `identity-mailbox-sync.service.spec.ts`); this proves the WIRING
      // itself calls it on both occasions, which is the assumption that test
      // relies on.
      coManagers.findOne.mockResolvedValue(seat());
      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Invited }),
      );
      await service.respondToInvite('seat-1', INVITEE_ID, 'accept');

      expect(identityMailboxSync.onStaffAdded).toHaveBeenCalledTimes(2);
      expect(identityMailboxSync.onStaffAdded).toHaveBeenNthCalledWith(
        1,
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
      expect(identityMailboxSync.onStaffAdded).toHaveBeenNthCalledWith(
        2,
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
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

    it('ends the mailbox seat when an active seat is revoked', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
    });

    // CW-24: the live-room eviction event must not go out until the
    // transaction that ends the seat has actually resolved, mirroring
    // `GroupsService.leaveGroup`'s post-commit fan-out. `onStaffRemoved` is
    // asked to defer (asserted above), and `emitSeatChanges` (Task 25: the
    // eviction, the claim releases and the staffing change together) is the
    // one place that is allowed to fire it, only after `dataSource
    // .transaction(...)` has returned.
    it('emits the mailbox eviction only after the transaction resolves', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );
      const removedChanges = {
        endedSeats: [{ conversationId: 'conversation-1', userId: INVITEE_ID }],
        releasedClaims: [],
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: false,
          },
        ],
      };
      identityMailboxSync.onStaffRemoved.mockImplementation(async () => {
        // Called from inside the transaction callback: the fan-out must not
        // have happened yet at this point.
        expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
        return removedChanges;
      });

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        removedChanges,
      );
    });

    it('never emits the mailbox eviction when the transaction rolls back', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );
      transactionManager.save.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.revoke('QPL-2026-0001', OWNER_ID, 'mika'),
      ).rejects.toThrow('db down');

      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    // Task 25 m3: the stronger rollback shape the accept path uses. The
    // callback runs to the end, seat ending included, and then the commit
    // fails, so an emit placed anywhere inside the callback is caught.
    it('never emits the mailbox changes when the revoke commit fails', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );
      identityMailboxSync.onStaffRemoved.mockResolvedValue({
        endedSeats: [{ conversationId: 'conversation-1', userId: INVITEE_ID }],
        releasedClaims: [],
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: false,
          },
        ],
      });
      const dataSource = (
        service as unknown as { dataSource: { transaction: jest.Mock } }
      ).dataSource;
      dataSource.transaction.mockImplementationOnce(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          await work(transactionManager as unknown as EntityManager);
          throw new Error('commit failed');
        },
      );

      await expect(
        service.revoke('QPL-2026-0001', OWNER_ID, 'mika'),
      ).rejects.toThrow('commit failed');

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    it('reads the seat under a row lock before it flips the status', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(coManagers.findOne).toHaveBeenCalledWith({
        where: { listingId: 'listing-1', userId: INVITEE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(coManagers.findOne.mock.invocationCallOrder[0]).toBeLessThan(
        coManagers.update.mock.invocationCallOrder[0] ?? 0,
      );
    });

    // The race this closes: a revoke read the seat as `invited`, an accept
    // committed `active` and seated the member, and the revoke's flip still
    // matched. The lock now serializes the two, and the seat sync runs for
    // every live row anyway, so an unanswered invitation also ends any
    // mailbox seat, in the same transaction, with no history row.
    it('ends the mailbox seat for an unanswered invitation too, in the same transaction', async () => {
      coManagers.findOne.mockResolvedValue(seat());

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
      expect(transactionManager.save).not.toHaveBeenCalled();
    });

    // One side of the serialized race: the accept committed before the
    // revoke took its lock, so the locked read sees `active`. The lock
    // assertions above and the unanswered-invitation test cover the rest.
    it('ends the mailbox seat of an active co-manager whose accept committed first, evicting them after commit', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );
      const acceptedThenRevokedChanges = {
        endedSeats: [{ conversationId: 'conversation-1', userId: INVITEE_ID }],
        releasedClaims: [],
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: false,
          },
        ],
      };
      identityMailboxSync.onStaffRemoved.mockResolvedValue(
        acceptedThenRevokedChanges,
      );

      await service.revoke('QPL-2026-0001', OWNER_ID, 'mika');

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        acceptedThenRevokedChanges,
      );
    });

    it('keeps the mailbox seat of a member who is now the owner of record', async () => {
      // A staff-attached seat spared by an ownership transfer to its own
      // holder: revoking the seat leaves them the owner, and staff.
      slugResolvesTo('owner-slug', OWNER_ID);
      coManagers.findOne.mockResolvedValue(
        seat({ userId: OWNER_ID, status: ListingCoManagerStatus.Active }),
      );

      await service.staffRevokeCoManager(
        'QPL-2026-0001',
        'admin-1',
        'owner-slug',
      );

      expect(coManagers.update).toHaveBeenCalled();
      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
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

    it('ends the mailbox seat for the member who stepped down', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );

      await service.leave('QPL-2026-0001', INVITEE_ID);

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        'listing-identity-1',
        INVITEE_ID,
        transactionManager,
        { shouldDeferEmission: true },
      );
      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        NO_MAILBOX_CHANGES,
      );
    });

    it('never emits the mailbox changes when the leave commit fails', async () => {
      coManagers.findOne.mockResolvedValue(
        seat({ status: ListingCoManagerStatus.Active }),
      );
      identityMailboxSync.onStaffRemoved.mockResolvedValue({
        endedSeats: [{ conversationId: 'conversation-1', userId: INVITEE_ID }],
        releasedClaims: [],
        staffingChanges: [
          {
            identityId: 'listing-identity-1',
            userId: INVITEE_ID,
            isStaff: false,
          },
        ],
      });
      const dataSource = (
        service as unknown as { dataSource: { transaction: jest.Mock } }
      ).dataSource;
      dataSource.transaction.mockImplementationOnce(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          await work(transactionManager as unknown as EntityManager);
          throw new Error('commit failed');
        },
      );

      await expect(service.leave('QPL-2026-0001', INVITEE_ID)).rejects.toThrow(
        'commit failed',
      );

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
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
