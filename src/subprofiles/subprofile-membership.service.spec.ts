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
import { SUBPROFILE_CREATOR_CHANGED } from './subprofile.events';

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
const SUCCESSOR_ID = 'successor-1';

const makeSubprofile = (overrides: Partial<Subprofile> = {}): Subprofile =>
  ({
    id: SUBPROFILE_ID,
    userId: CREATOR_ID,
    slug: 'test-persona',
    displayName: 'Test Persona',
    ...overrides,
  }) as Subprofile;

describe('SubprofileMembershipService', () => {
  let service: SubprofileMembershipService;
  let subprofiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let sharedPersonaRows: { id: string }[];
  let members: { findOne: jest.Mock; delete: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let identities: { ensureIdentityFor: jest.Mock };
  let identityMailboxSync: {
    onStaffRemoved: jest.Mock;
    resyncMailbox: jest.Mock;
    emitSeatChanges: jest.Mock;
  };
  let manager: {
    findOne: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    find: jest.Mock;
    query: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    sharedPersonaRows = [];
    const sharedPersonaQuery = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(() => Promise.resolve(sharedPersonaRows)),
    };
    subprofiles = {
      findOne: jest.fn().mockResolvedValue(makeSubprofile()),
      // Backs `handOverCreatedPersonasFor`'s selection of the shared personas
      // a user created; each test sets `sharedPersonaRows`.
      createQueryBuilder: jest.fn(() => sharedPersonaQuery),
    };
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
      resyncMailbox: jest.fn().mockResolvedValue({
        endedSeats: [],
        releasedClaims: [],
        staffingChanges: [],
      }),
      emitSeatChanges: jest.fn(),
    };
    manager = {
      // The persona row lock read inside the `leave` and `removeMember`
      // transactions. `removeMember` re-checks the creator on the returned
      // row, so the default names `CREATOR_ID` as creator.
      findOne: jest.fn().mockResolvedValue(makeSubprofile()),
      // Above the last-owner floor by default, so `leave` proceeds.
      count: jest.fn().mockResolvedValue(2),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      // The creator handoff reads: the remaining roster (one co-owner who
      // joined after the creator) and the successor's own persona slugs.
      find: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === SubprofileMember
            ? [
                {
                  id: 'member-row-2',
                  subprofileId: SUBPROFILE_ID,
                  userId: SUCCESSOR_ID,
                  position: 0,
                  joinedAt: new Date('2026-01-02T00:00:00Z'),
                },
              ]
            : [],
        ),
      ),
      query: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
        manager,
        { shouldDeferEmission: true },
      );
      const [, calledUserId] = identityMailboxSync.onStaffRemoved.mock
        .calls[0] as [string, string];
      expect(calledUserId).toBe(TARGET_ID);
      expect(calledUserId).not.toBe(CREATOR_ID);
    });

    // Access ends in the same transaction as the removal: the roster delete
    // runs through the transaction's manager, after the persona row lock,
    // and the seat sync joins that same manager.
    it('deletes the roster row and ends the seat in one transaction, under the persona lock', async () => {
      await service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: SUBPROFILE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.delete).toHaveBeenCalledWith(SubprofileMember, {
        subprofileId: SUBPROFILE_ID,
        userId: TARGET_ID,
      });
      expect(members.delete).not.toHaveBeenCalled();
      const lockOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const deleteOrder = manager.delete.mock.invocationCallOrder[0] ?? 0;
      const syncOrder =
        identityMailboxSync.onStaffRemoved.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeLessThan(deleteOrder);
      expect(deleteOrder).toBeLessThan(syncOrder);
      const [, , managerArgument] = identityMailboxSync.onStaffRemoved.mock
        .calls[0] as [string, string, unknown];
      expect(managerArgument).toBe(manager);
    });

    it('emits the mailbox changes only after the transaction resolves', async () => {
      const removedChanges = {
        endedSeats: [{ conversationId: 'conversation-1', userId: TARGET_ID }],
        releasedClaims: [],
        staffingChanges: [
          { identityId: IDENTITY_ID, userId: TARGET_ID, isStaff: false },
        ],
      };
      identityMailboxSync.onStaffRemoved.mockImplementation(async () => {
        expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
        return removedChanges;
      });

      await service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug');

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
        removedChanges,
      );
    });

    it('rolls the removal back with a failed seat sync, emitting nothing', async () => {
      identityMailboxSync.onStaffRemoved.mockRejectedValueOnce(
        new Error('sync failed'),
      );

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toThrow('sync failed');

      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('never emits the mailbox changes when the removal commit fails', async () => {
      dataSource.transaction.mockImplementationOnce(
        async (
          work: (transactionManager: typeof manager) => Promise<unknown>,
        ) => {
          await work(manager);
          throw new Error('commit failed');
        },
      );

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toThrow('commit failed');

      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not end any mailbox seat when the target row is already gone', async () => {
      manager.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
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

    // The race the lock re-check closes: the creator leaves in one tab while
    // removing a co-owner in another. The gate read still names the caller as
    // creator, but the leave has committed by the time the lock is taken, and
    // the locked row names the successor (here the removal's own target).
    it('refuses a stale removal once a concurrent leave has handed the persona on', async () => {
      subprofiles.findOne.mockResolvedValue(makeSubprofile());
      manager.findOne.mockResolvedValue(makeSubprofile({ userId: TARGET_ID }));

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: SUBPROFILE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.delete).not.toHaveBeenCalled();
      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers 404 when the persona is gone by the time the lock is taken', async () => {
      manager.findOne.mockResolvedValue(null);

      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(identityMailboxSync.onStaffRemoved).not.toHaveBeenCalled();
    });
  });

  describe('leave by the creator', () => {
    const creatorChangedEmits = (): unknown[][] =>
      (eventEmitter.emit.mock.calls as unknown[][]).filter(
        ([eventName]) => eventName === SUBPROFILE_CREATOR_CHANGED,
      );

    it('hands the creator role to the successor inside the leave transaction', async () => {
      await service.leave(CREATOR_ID, SUBPROFILE_ID);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: SUBPROFILE_ID },
        { userId: SUCCESSOR_ID },
      );
      // Order inside the one transaction: lock, roster delete, seat end,
      // then the handoff.
      const lockOrder = manager.findOne.mock.invocationCallOrder[0] ?? 0;
      const deleteOrder = manager.delete.mock.invocationCallOrder[0] ?? 0;
      const seatEndOrder =
        identityMailboxSync.onStaffRemoved.mock.invocationCallOrder[0] ?? 0;
      const handoffOrder = manager.update.mock.invocationCallOrder[0] ?? 0;
      expect(lockOrder).toBeLessThan(deleteOrder);
      expect(deleteOrder).toBeLessThan(seatEndOrder);
      expect(seatEndOrder).toBeLessThan(handoffOrder);
    });

    it('emits the creator change to every remaining member after the commit', async () => {
      identityMailboxSync.resyncMailbox.mockImplementation(async () => {
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        return { endedSeats: [], releasedClaims: [], staffingChanges: [] };
      });

      await service.leave(CREATOR_ID, SUBPROFILE_ID);

      expect(creatorChangedEmits()).toEqual([
        [
          SUBPROFILE_CREATOR_CHANGED,
          {
            subprofileId: SUBPROFILE_ID,
            displayName: 'Test Persona',
            newCreatorUserId: SUCCESSOR_ID,
            memberUserIds: [SUCCESSOR_ID],
          },
        ],
      ]);
    });

    it('sends the departure and the handoff seat changes together after the commit', async () => {
      identityMailboxSync.onStaffRemoved.mockResolvedValue({
        endedSeats: [{ conversationId: 'conversation-1', userId: CREATOR_ID }],
        releasedClaims: [],
        staffingChanges: [
          { identityId: IDENTITY_ID, userId: CREATOR_ID, isStaff: false },
        ],
      });

      await service.leave(CREATOR_ID, SUBPROFILE_ID);

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledTimes(1);
      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith({
        endedSeats: [{ conversationId: 'conversation-1', userId: CREATOR_ID }],
        releasedClaims: [],
        staffingChanges: [
          { identityId: IDENTITY_ID, userId: CREATOR_ID, isStaff: false },
          { identityId: IDENTITY_ID, userId: SUCCESSOR_ID, isStaff: true },
        ],
      });
    });

    it('emits nothing when the handoff commit fails', async () => {
      dataSource.transaction.mockImplementationOnce(
        async (
          work: (transactionManager: typeof manager) => Promise<unknown>,
        ) => {
          await work(manager);
          throw new Error('commit failed');
        },
      );

      await expect(service.leave(CREATOR_ID, SUBPROFILE_ID)).rejects.toThrow(
        'commit failed',
      );

      expect(manager.update).toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rolls the leave back with a failed handoff write, emitting nothing', async () => {
      manager.update.mockRejectedValueOnce(new Error('db down'));

      await expect(service.leave(CREATOR_ID, SUBPROFILE_ID)).rejects.toThrow(
        'db down',
      );

      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('keeps the last-owner guard: a sole creator still cannot leave', async () => {
      manager.count.mockResolvedValue(1);

      await expect(
        service.leave(CREATOR_ID, SUBPROFILE_ID),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not transfer when a co-owner who is not the creator leaves', async () => {
      await service.leave(DEPARTING_ID, SUBPROFILE_ID);

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
      expect(identityMailboxSync.resyncMailbox).not.toHaveBeenCalled();
      expect(creatorChangedEmits()).toHaveLength(0);
    });

    // The creator gates (`removeMember` here, and `update`/`unpublish`/
    // `remove` in `SubprofilesService`) all compare a freshly read
    // `sp.userId` with the caller. Here the persona is a stored row that only
    // `manager.update` changes, and every read hands out a new copy of it, so
    // the successor passes the gate only if the handoff was actually written
    // (an in-place change to the transaction's own copy proves nothing).
    it('lets the successor through the creator gate once the handoff is written', async () => {
      let storedPersona = makeSubprofile();
      const readStoredPersona = () => Promise.resolve({ ...storedPersona });
      manager.findOne.mockImplementation(readStoredPersona);
      subprofiles.findOne.mockImplementation(readStoredPersona);
      manager.update.mockImplementation(
        (
          _entity: unknown,
          _criteria: unknown,
          changes: Partial<Subprofile>,
        ) => {
          storedPersona = { ...storedPersona, ...changes };
          return Promise.resolve({ affected: 1 });
        },
      );
      profiles.findOne.mockResolvedValue({
        userId: TARGET_ID,
        slug: 'target-slug',
      });

      await expect(
        service.removeMember(SUCCESSOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await service.leave(CREATOR_ID, SUBPROFILE_ID);
      await service.removeMember(SUCCESSOR_ID, SUBPROFILE_ID, 'target-slug');

      expect(storedPersona.userId).toBe(SUCCESSOR_ID);
      expect(manager.delete).toHaveBeenLastCalledWith(SubprofileMember, {
        subprofileId: SUBPROFILE_ID,
        userId: TARGET_ID,
      });
      await expect(
        service.removeMember(CREATOR_ID, SUBPROFILE_ID, 'target-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('handOverCreatedPersonasFor', () => {
    const SHARED_PERSONA_ID = 'sp-shared';

    beforeEach(() => {
      sharedPersonaRows = [{ id: SHARED_PERSONA_ID }];
      manager.findOne.mockResolvedValue(
        makeSubprofile({ id: SHARED_PERSONA_ID }),
      );
      // One member other than the erased creator.
      manager.count.mockResolvedValue(1);
    });

    it('ends the erased creator membership and seat, then hands the persona over', async () => {
      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
        IdentityKind.Subprofile,
        SHARED_PERSONA_ID,
      );
      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: SHARED_PERSONA_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.delete).toHaveBeenCalledWith(SubprofileMember, {
        subprofileId: SHARED_PERSONA_ID,
        userId: CREATOR_ID,
      });
      expect(identityMailboxSync.onStaffRemoved).toHaveBeenCalledWith(
        IDENTITY_ID,
        CREATOR_ID,
        manager,
        { shouldDeferEmission: true },
      );
      expect(manager.update).toHaveBeenCalledWith(
        Subprofile,
        { id: SHARED_PERSONA_ID },
        { userId: SUCCESSOR_ID },
      );
    });

    it('emits the seat changes and the creator change after each commit', async () => {
      identityMailboxSync.resyncMailbox.mockImplementation(async () => {
        expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        return { endedSeats: [], releasedClaims: [], staffingChanges: [] };
      });

      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SUBPROFILE_CREATOR_CHANGED,
        {
          subprofileId: SHARED_PERSONA_ID,
          displayName: 'Test Persona',
          newCreatorUserId: SUCCESSOR_ID,
          memberUserIds: [SUCCESSOR_ID],
        },
      );
    });

    it('runs one transaction per persona', async () => {
      sharedPersonaRows = [{ id: 'sp-a' }, { id: 'sp-b' }];
      manager.findOne.mockImplementation(
        (_entity: unknown, options: { where: { id: string } }) =>
          Promise.resolve(makeSubprofile({ id: options.where.id })),
      );

      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the user created no shared persona', async () => {
      sharedPersonaRows = [];

      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('skips a persona whose only member is the creator', async () => {
      manager.count.mockResolvedValue(0);

      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    // A retry after a partial run: the persona already carries its new
    // creator, so the re-check under the lock leaves it alone.
    it('is idempotent: a persona already handed over is left alone', async () => {
      manager.findOne.mockResolvedValue(
        makeSubprofile({ id: SHARED_PERSONA_ID, userId: SUCCESSOR_ID }),
      );

      await service.handOverCreatedPersonasFor(CREATOR_ID);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('announces the committed persona and stops when a later one fails', async () => {
      sharedPersonaRows = [{ id: 'sp-a' }, { id: 'sp-b' }];
      manager.findOne.mockImplementation(
        (_entity: unknown, options: { where: { id: string } }) =>
          Promise.resolve(makeSubprofile({ id: options.where.id })),
      );
      manager.update
        .mockResolvedValueOnce({ affected: 1 })
        .mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.handOverCreatedPersonasFor(CREATOR_ID),
      ).rejects.toThrow('db down');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SUBPROFILE_CREATOR_CHANGED,
        expect.objectContaining({ subprofileId: 'sp-a' }),
      );
    });
  });
});
