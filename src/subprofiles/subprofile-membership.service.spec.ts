import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { Profile } from '../users/entities/profile.entity';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileMembershipService } from './subprofile-membership.service';

/**
 * Seat-ending coverage for `leave` and `removeMember`: the two paths that end
 * a co-owner's `conversation_participants` seat, which is the guarantee this
 * task exists to protect. Modelled on the wiring tests in
 * `listing-co-managers.service.spec.ts`.
 */

const SUBPROFILE_ID = 'sp-1';
const CREATOR_ID = 'creator-1';
const DEPARTING_ID = 'departing-1';
const TARGET_ID = 'target-1';
const IDENTITY_ID = 'subprofile-identity-1';

const makeSubprofile = (overrides: Partial<Subprofile> = {}): Subprofile =>
  ({
    id: SUBPROFILE_ID,
    userId: CREATOR_ID,
    displayName: 'Test Persona',
    ...overrides,
  }) as Subprofile;

describe('SubprofileMembershipService', () => {
  let service: SubprofileMembershipService;
  let subprofiles: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; delete: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let identities: { ensureIdentityFor: jest.Mock };
  let identityMailboxSync: {
    onStaffRemoved: jest.Mock;
    emitSeatChanges: jest.Mock;
  };
  let manager: { findOne: jest.Mock; count: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    subprofiles = { findOne: jest.fn().mockResolvedValue(makeSubprofile()) };
    members = {
      // Backs `isMember`/`getOwned` for BOTH `leave` (called with the
      // departing user) and `removeMember` (called with the creator): a
      // truthy row by default means both callers pass the membership gate
      // unless a test overrides it.
      findOne: jest.fn().mockResolvedValue({ id: 'member-row-1' }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profiles = { findOne: jest.fn() };
    eventEmitter = { emit: jest.fn() };
    identities = {
      ensureIdentityFor: jest.fn().mockResolvedValue({ id: IDENTITY_ID }),
    };
    identityMailboxSync = {
      onStaffRemoved: jest.fn().mockResolvedValue({
        endedSeats: [],
        releasedClaims: [],
        staffingChanges: [],
      }),
      emitSeatChanges: jest.fn(),
    };
    manager = {
      // The lock read inside `leave`'s transaction; its return value is
      // never inspected by the service, only the lock itself matters.
      findOne: jest.fn().mockResolvedValue(makeSubprofile()),
      // Above the last-owner floor by default, so `leave` proceeds.
      count: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (transactionManager: typeof manager) => Promise<unknown>) =>
          work(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofileMembershipService,
        { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
        { provide: getRepositoryToken(SubprofileMember), useValue: members },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: IdentitiesService, useValue: identities },
        {
          provide: IdentityMailboxSyncService,
          useValue: identityMailboxSync,
        },
      ],
    }).compile();
    service = module.get(SubprofileMembershipService);
  });

  describe('leave', () => {
    it('ends the mailbox seat with the persona identity and the departing user id', async () => {
      await service.leave(DEPARTING_ID, SUBPROFILE_ID);

      expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
        IdentityKind.Subprofile,
        SUBPROFILE_ID,
      );
      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        IDENTITY_ID,
        DEPARTING_ID,
        manager,
        { shouldDeferEmission: true },
      );
    });

    // Joins the same transaction as the membership delete, so a failed sync
    // rolls the departure back with it: the third argument above is exactly
    // the manager the `dataSource.transaction` callback received.
    it('runs the hook inside the same transaction as the membership delete', async () => {
      await service.leave(DEPARTING_ID, SUBPROFILE_ID);

      const [, , managerArgument] = identityMailboxSync.onStaffRemoved.mock
        .calls[0] as [string, string, unknown];
      expect(managerArgument).toBe(manager);
    });

    // CW-24: the live-room eviction event must not go out until the
    // transaction that ends the seat has actually resolved, mirroring
    // `GroupsService.leaveGroup`'s post-commit fan-out. `onStaffRemoved` is
    // asked to defer (asserted above), and `emitSeatChanges` (Task 25: the
    // eviction, the claim releases and the staffing change together) is the
    // one place allowed to fire it, only after `dataSource.transaction(...)`
    // has returned.
    it('emits the mailbox eviction only after the transaction resolves', async () => {
      const removedChanges = {
        endedSeats: [
          { conversationId: 'conversation-1', userId: DEPARTING_ID },
        ],
        releasedClaims: [],
        staffingChanges: [
          { identityId: IDENTITY_ID, userId: DEPARTING_ID, isStaff: false },
        ],
      };
      identityMailboxSync.onStaffRemoved.mockImplementation(async () => {
        expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
        return removedChanges;
      });

      await service.leave(DEPARTING_ID, SUBPROFILE_ID);

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        removedChanges,
      );
    });

    it('never emits the mailbox eviction when the transaction rolls back', async () => {
      manager.delete.mockRejectedValueOnce(new Error('db down'));

      await expect(service.leave(DEPARTING_ID, SUBPROFILE_ID)).rejects.toThrow(
        'db down',
      );

      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    // Task 25 m3: the stronger rollback shape the accept paths use. The
    // callback runs to the end, seat ending included, and then the commit
    // fails, so an emit placed anywhere inside the callback is caught.
    it('never emits the mailbox changes when the leave commit fails', async () => {
      identityMailboxSync.onStaffRemoved.mockResolvedValue({
        endedSeats: [
          { conversationId: 'conversation-1', userId: DEPARTING_ID },
        ],
        releasedClaims: [],
        staffingChanges: [
          { identityId: IDENTITY_ID, userId: DEPARTING_ID, isStaff: false },
        ],
      });
      dataSource.transaction.mockImplementationOnce(
        async (
          work: (transactionManager: typeof manager) => Promise<unknown>,
        ) => {
          await work(manager);
          throw new Error('commit failed');
        },
      );

      await expect(service.leave(DEPARTING_ID, SUBPROFILE_ID)).rejects.toThrow(
        'commit failed',
      );

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
    });

    it('does not end the mailbox seat when the last-owner guard blocks the leave', async () => {
      manager.count.mockResolvedValue(1);

      await expect(
        service.leave(DEPARTING_ID, SUBPROFILE_ID),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
    });

    it('does not end the mailbox seat when the caller holds no membership row', async () => {
      // `isMember` fails, so `getOwned` 403s before the transaction, and
      // before the seat sync, ever opens.
      members.findOne.mockResolvedValue(null);

      await expect(
        service.leave(DEPARTING_ID, SUBPROFILE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
    });
  });

  describe('removeMember', () => {
    const targetProfile = { userId: TARGET_ID, slug: 'target-slug' } as Profile;

    beforeEach(() => {
      profiles.findOne.mockResolvedValue(targetProfile);
    });

    it('ends the REMOVED member seat, never the actor', async () => {
      await service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug');

      expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
        IdentityKind.Subprofile,
        SUBPROFILE_ID,
      );
      // The transposition case the review asked for: the removed member's
      // id is the second argument. A swap with the creator's id fails this.
      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        IDENTITY_ID,
        TARGET_ID,
      );
      const [, calledUserId] = identityMailboxSync.onStaffRemoved.mock
        .calls[0] as [string, string];
      expect(calledUserId).toBe(TARGET_ID);
      expect(calledUserId).not.toBe(CREATOR_ID);
    });

    // `removeMember` has no surrounding transaction in the production code
    // (the roster delete is a plain repository call, never
    // `dataSource.transaction`), so there is no manager for the hook to
    // join. This asserts the hook is called with exactly two arguments,
    // matching that shape honestly instead of inventing a transaction that
    // does not exist.
    it('calls onStaffRemoved with no manager, since removeMember opens no transaction', async () => {
      await service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug');

      const call = identityMailboxSync.onStaffRemoved.mock.calls[0];
      expect(call).toHaveLength(2);
    });

    it('does not end any mailbox seat when the target row is already gone', async () => {
      members.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
    });

    it('does not end any mailbox seat when the caller is not the creator', async () => {
      subprofiles.findOne.mockResolvedValue(
        makeSubprofile({ userId: 'someone-else' }),
      );

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
    });
  });
});
