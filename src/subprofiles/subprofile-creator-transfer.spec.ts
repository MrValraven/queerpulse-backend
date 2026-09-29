import { EntityManager, In, Not } from 'typeorm';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
} from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  resolveTransferredSlug,
  transferCreatorWithin,
} from './subprofile-creator-transfer';
import { MAX_SUBPROFILES } from './subprofile-validation';
import {
  claimHandleWithin,
  isHandleTakenWithin,
  releaseHandleWithin,
} from '../handles/handles.service';
import { ConflictException } from '@nestjs/common';
import { HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandleHistory } from '../handles/entities/handle-history.entity';
import { Profile } from '../users/entities/profile.entity';
import { linkedPersonaHandleCandidate } from './persona-handle';

// The registry writes a creator-named handle re-issue makes (PRD-431). Only
// that path reaches them; their own behaviour is covered in
// `handles.service.spec.ts`.
jest.mock('../handles/handles.service', () => ({
  ...jest.requireActual<Record<string, unknown>>('../handles/handles.service'),
  claimHandleWithin: jest.fn(),
  isHandleTakenWithin: jest.fn(),
  releaseHandleWithin: jest.fn(),
}));

/**
 * `transferCreatorWithin` against a mocked transaction manager: who succeeds
 * the creator, which slug the persona lands on, and which writes ride the
 * caller's transaction. The Postgres-level behaviour (the address-history
 * upsert) is asserted through the SQL and parameters it sends.
 */

const SUBPROFILE_ID = 'sp-1';
const DEPARTING_ID = 'creator-1';
const IDENTITY_ID = 'subprofile-identity-1';

const makeSubprofile = (overrides: Partial<Subprofile> = {}): Subprofile =>
  ({
    id: SUBPROFILE_ID,
    userId: DEPARTING_ID,
    slug: 'night-shift',
    displayName: 'Night Shift',
    linkVisibility: SubprofileLinkVisibility.Linked,
    ...overrides,
  }) as Subprofile;

const makeMember = (
  id: string,
  userId: string,
  joinedAt: string,
): SubprofileMember => ({
  id,
  subprofileId: SUBPROFILE_ID,
  userId,
  position: 0,
  joinedAt: new Date(joinedAt),
});

const emptyChanges = () => ({
  endedSeats: [],
  releasedClaims: [],
  staffingChanges: [] as {
    identityId: string;
    userId: string;
    isStaff: boolean;
  }[],
});

describe('resolveTransferredSlug', () => {
  it('keeps the slug when the new creator has no persona at it', () => {
    expect(resolveTransferredSlug('night-shift', new Set(['other']))).toBe(
      'night-shift',
    );
  });

  it('suffixes -2 on a collision', () => {
    expect(
      resolveTransferredSlug('night-shift', new Set(['night-shift'])),
    ).toBe('night-shift-2');
  });

  it('suffixes -3 when -2 is taken too', () => {
    expect(
      resolveTransferredSlug(
        'night-shift',
        new Set(['night-shift', 'night-shift-2']),
      ),
    ).toBe('night-shift-3');
  });
});

describe('transferCreatorWithin', () => {
  let remainingMembers: SubprofileMember[];
  let successorPersonas: Pick<Subprofile, 'slug'>[];
  // User ids whose account is active (`users.status = 'active'`).
  let activeUserIds: string[];
  let manager: {
    find: jest.Mock;
    query: jest.Mock;
    update: jest.Mock;
  };
  let identityMailboxSync: { resyncMailbox: jest.Mock };

  const transfer = (subprofile: Subprofile, departingUserId = DEPARTING_ID) =>
    transferCreatorWithin(
      manager as unknown as EntityManager,
      subprofile,
      departingUserId,
      {
        identityId: IDENTITY_ID,
        identityMailboxSync:
          identityMailboxSync as unknown as IdentityMailboxSyncService,
      },
    );

  const queriesMatching = (fragment: string) =>
    manager.query.mock.calls.filter(([sql]) =>
      String(sql).includes(fragment),
    ) as [string, unknown[]][];

  beforeEach(() => {
    remainingMembers = [
      makeMember('member-2', 'successor-1', '2026-01-02T00:00:00Z'),
      makeMember('member-3', 'member-later', '2026-01-03T00:00:00Z'),
    ];
    successorPersonas = [{ slug: 'something-else' }];
    activeUserIds = ['successor-1', 'member-later'];
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === SubprofileMember) {
          return Promise.resolve(remainingMembers);
        }
        if (entity === User) {
          return Promise.resolve(activeUserIds.map((id) => ({ id })));
        }
        return Promise.resolve(successorPersonas);
      }),
      query: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    identityMailboxSync = {
      resyncMailbox: jest.fn().mockResolvedValue(emptyChanges()),
    };
  });

  it('does nothing when the departing member is not the creator', async () => {
    const result = await transfer(makeSubprofile(), 'co-owner-9');

    expect(result).toBeNull();
    expect(manager.find).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(identityMailboxSync.resyncMailbox).not.toHaveBeenCalled();
  });

  it('does nothing when no other member remains', async () => {
    remainingMembers = [];

    const result = await transfer(makeSubprofile());

    expect(result).toBeNull();
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('reads the roster without the departing member, oldest first', async () => {
    await transfer(makeSubprofile());

    expect(manager.find).toHaveBeenCalledWith(SubprofileMember, {
      where: { subprofileId: SUBPROFILE_ID, userId: Not(DEPARTING_ID) },
      order: { joinedAt: 'ASC', id: 'ASC' },
    });
  });

  // The successor is the first row of that ordered read, used as Postgres
  // returns it: re-sorting in JavaScript would drop the microseconds of
  // `joined_at` and could disagree with the repair migration's pick.
  it('hands the persona to the first member of the ordered roster read', async () => {
    remainingMembers = [
      makeMember('member-2', 'successor-1', '2026-01-02T00:00:00Z'),
      makeMember('member-3', 'member-later', '2026-01-02T00:00:00Z'),
    ];

    const result = await transfer(makeSubprofile());

    expect(result?.newCreatorUserId).toBe('successor-1');
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { userId: 'successor-1' },
    );
  });

  it('reads which remaining members have an active account', async () => {
    await transfer(makeSubprofile());

    expect(manager.find).toHaveBeenNthCalledWith(2, User, {
      where: {
        id: In(['successor-1', 'member-later']),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
  });

  it('skips a longer-standing member whose account is not active', async () => {
    // `successor-1` joined first but is suspended or deactivated.
    activeUserIds = ['member-later'];

    const result = await transfer(makeSubprofile());

    expect(result?.newCreatorUserId).toBe('member-later');
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { userId: 'member-later' },
    );
  });

  it('falls back to the longest-standing member when nobody remaining is active', async () => {
    activeUserIds = [];

    const result = await transfer(makeSubprofile());

    expect(result?.newCreatorUserId).toBe('successor-1');
  });

  it('takes the create lock of the successor before reading their slugs', async () => {
    await transfer(makeSubprofile());

    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['subprofile_create:successor-1'],
    );
    const lockOrder = manager.query.mock.invocationCallOrder[0] ?? 0;
    const slugReadOrder = manager.find.mock.invocationCallOrder[2] ?? 0;
    expect(lockOrder).toBeLessThan(slugReadOrder);
    expect(manager.find).toHaveBeenNthCalledWith(3, Subprofile, {
      where: { userId: 'successor-1' },
      select: { slug: true },
    });
  });

  it('keeps the slug and writes no takedown row when the successor has no clash', async () => {
    const result = await transfer(makeSubprofile());

    expect(result?.slug).toBe('night-shift');
    expect(result?.previousSlug).toBe('night-shift');
    expect(queriesMatching('content_moderation')).toHaveLength(0);
  });

  it('suffixes -2 when the successor already has the slug', async () => {
    successorPersonas = [{ slug: 'night-shift' }];

    const result = await transfer(makeSubprofile());

    expect(result?.slug).toBe('night-shift-2');
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { userId: 'successor-1', slug: 'night-shift-2' },
    );
  });

  it('suffixes -3 when the successor holds the slug and its -2', async () => {
    successorPersonas = [{ slug: 'night-shift' }, { slug: 'night-shift-2' }];

    const result = await transfer(makeSubprofile());

    expect(result?.slug).toBe('night-shift-3');
  });

  it('writes no takedown row when the slug changes, since takedowns are keyed on the persona uuid', async () => {
    successorPersonas = [{ slug: 'night-shift' }];

    const result = await transfer(makeSubprofile());

    expect(result?.slug).toBe('night-shift-2');
    expect(queriesMatching('content_moderation')).toHaveLength(0);
  });

  it('transfers without error when the successor is already at the persona cap', async () => {
    successorPersonas = Array.from({ length: MAX_SUBPROFILES }, (_, index) => ({
      slug: `persona-${index}`,
    }));

    const result = await transfer(makeSubprofile());

    expect(result?.newCreatorUserId).toBe('successor-1');
    expect(manager.update).toHaveBeenCalled();
  });

  it('upserts the old address of a linked persona, keyed by the departing creator', async () => {
    await transfer(makeSubprofile());

    const historyQueries = queriesMatching('subprofile_address_history');
    expect(historyQueries).toHaveLength(1);
    const [sql, parameters] = historyQueries[0] ?? ['', []];
    expect(parameters).toEqual([DEPARTING_ID, 'night-shift', SUBPROFILE_ID]);
    expect(sql).toContain('ON CONFLICT ("previous_user_id", "slug")');
    expect(sql).toContain('"subprofile_id" = EXCLUDED."subprofile_id"');
    expect(sql).toContain('"moved_at" = now()');
  });

  // An unlinked persona never had the public address
  // `/members/<creator>/<slug>`, so a history row would only let that address
  // answer later and reveal who created the persona while it was unattributed.
  it('records no old address when the persona is unlinked', async () => {
    const result = await transfer(
      makeSubprofile({ linkVisibility: SubprofileLinkVisibility.Unlinked }),
    );

    expect(queriesMatching('subprofile_address_history')).toHaveLength(0);
    expect(result?.newCreatorUserId).toBe('successor-1');
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { userId: 'successor-1' },
    );
  });

  it('records the old address under the pre-suffix slug', async () => {
    successorPersonas = [{ slug: 'night-shift' }];

    await transfer(makeSubprofile());

    const [, parameters] = queriesMatching('subprofile_address_history')[0] ?? [
      '',
      [],
    ];
    expect(parameters).toEqual([DEPARTING_ID, 'night-shift', SUBPROFILE_ID]);
  });

  it('updates the passed row in place so later creator gates read the successor', async () => {
    successorPersonas = [{ slug: 'night-shift' }];
    const subprofile = makeSubprofile();

    await transfer(subprofile);

    expect(subprofile.userId).toBe('successor-1');
    expect(subprofile.slug).toBe('night-shift-2');
  });

  it('reconciles the mailbox in the same transaction with emission deferred', async () => {
    await transfer(makeSubprofile());

    expect(identityMailboxSync.resyncMailbox).toHaveBeenCalledWith(
      IDENTITY_ID,
      manager,
      { shouldDeferEmission: true },
    );
    const updateOrder = manager.update.mock.invocationCallOrder[0] ?? 0;
    const resyncOrder =
      identityMailboxSync.resyncMailbox.mock.invocationCallOrder[0] ?? 0;
    expect(updateOrder).toBeLessThan(resyncOrder);
  });

  it('adds a staffing change for the successor so their switcher refetches', async () => {
    const result = await transfer(makeSubprofile());

    expect(result?.seatChanges.staffingChanges).toEqual([
      { identityId: IDENTITY_ID, userId: 'successor-1', isStaff: true },
    ]);
  });

  it('does not duplicate the successor staffing change the resync already reported', async () => {
    const resyncChanges = emptyChanges();
    resyncChanges.staffingChanges.push({
      identityId: IDENTITY_ID,
      userId: 'successor-1',
      isStaff: true,
    });
    identityMailboxSync.resyncMailbox.mockResolvedValue(resyncChanges);

    const result = await transfer(makeSubprofile());

    expect(result?.seatChanges.staffingChanges).toHaveLength(1);
  });

  it('builds the event for every remaining member and never names the member who left', async () => {
    const result = await transfer(makeSubprofile());

    expect(result?.creatorChangedEvent).toEqual({
      subprofileId: SUBPROFILE_ID,
      displayName: 'Night Shift',
      newCreatorUserId: 'successor-1',
      memberUserIds: ['successor-1', 'member-later'],
    });
    expect(JSON.stringify(result?.creatorChangedEvent)).not.toContain(
      DEPARTING_ID,
    );
  });

  it('propagates a failed write so the caller transaction rolls back', async () => {
    manager.update.mockRejectedValueOnce(new Error('db down'));

    await expect(transfer(makeSubprofile())).rejects.toThrow('db down');

    expect(identityMailboxSync.resyncMailbox).not.toHaveBeenCalled();
  });
});

// PRD-431: a linked handle that carries the departing creator's slug is
// re-issued from the successor's slug and released without forwarding; any
// other handle stays.
describe('transferCreatorWithin: creator-named handle', () => {
  const SUCCESSOR_ID = 'successor-1';
  const personaOwner = { kind: 'subprofile', subprofileId: SUBPROFILE_ID };
  const profileSlugs: Record<string, string> = {
    [DEPARTING_ID]: 'robin',
    [SUCCESSOR_ID]: 'sam',
  };
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    query: jest.Mock;
    update: jest.Mock;
    transaction: jest.Mock;
  };
  // `handle_history` rows: the departing member's former usernames, and the
  // reservations this persona left that still forward.
  let formerUsernames: string[];
  let forwardingPersonaReservations: string[];
  const claimHandle = claimHandleWithin as jest.Mock;
  const releaseHandle = releaseHandleWithin as jest.Mock;
  const isHandleTaken = isHandleTakenWithin as jest.Mock;

  const transfer = (subprofile: Subprofile) =>
    transferCreatorWithin(
      manager as unknown as EntityManager,
      subprofile,
      DEPARTING_ID,
      {
        identityId: IDENTITY_ID,
        identityMailboxSync: {
          resyncMailbox: jest.fn().mockResolvedValue(emptyChanges()),
        } as unknown as IdentityMailboxSyncService,
      },
    );

  const handleUpdates = () =>
    (manager.update.mock.calls as [unknown, unknown, object][]).filter(
      ([, , values]) => 'handle' in values,
    );

  beforeEach(() => {
    claimHandle.mockReset().mockResolvedValue(undefined);
    releaseHandle.mockReset().mockResolvedValue(undefined);
    isHandleTaken.mockReset().mockResolvedValue(false);
    formerUsernames = [];
    forwardingPersonaReservations = [];
    manager = {
      find: jest.fn(
        (
          entity: unknown,
          options?: { where?: { previousOwnerKind?: HandleOwnerKind } },
        ) => {
          if (entity === HandleHistory) {
            const names =
              options?.where?.previousOwnerKind === HandleOwnerKind.Profile
                ? formerUsernames
                : forwardingPersonaReservations;
            return Promise.resolve(names.map((name) => ({ name })));
          }
          if (entity === SubprofileMember) {
            return Promise.resolve([
              makeMember('member-2', SUCCESSOR_ID, '2026-01-02T00:00:00Z'),
            ]);
          }
          if (entity === User) {
            return Promise.resolve([{ id: SUCCESSOR_ID }]);
          }
          return Promise.resolve([]);
        },
      ),
      findOne: jest.fn(
        (entity: unknown, options: { where: { userId: string } }) => {
          const slug =
            entity === Profile ? profileSlugs[options.where.userId] : undefined;
          return Promise.resolve(
            slug ? { userId: options.where.userId, slug } : null,
          );
        },
      ),
      exists: jest.fn().mockResolvedValue(false),
      query: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      // A nested transaction on the caller's manager (a SAVEPOINT).
      transaction: jest.fn(
        (runInSavepoint: (savepointManager: unknown) => Promise<unknown>) =>
          runInSavepoint(manager),
      ),
    };
  });

  it('re-issues a published creator-named handle, releasing the old one without forwarding', async () => {
    const subprofile = makeSubprofile({
      status: SubprofileStatus.Published,
      handle: 'robin-night-shift',
    });

    await transfer(subprofile);

    expect(releaseHandle).toHaveBeenCalledWith(
      manager,
      'robin-night-shift',
      personaOwner,
      { isForwarding: false },
    );
    expect(claimHandle).toHaveBeenCalledWith(
      manager,
      'sam-night-shift',
      personaOwner,
    );
    const releaseOrder = releaseHandle.mock.invocationCallOrder[0] ?? 0;
    const claimOrder = claimHandle.mock.invocationCallOrder[0] ?? 0;
    expect(releaseOrder).toBeLessThan(claimOrder);
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { handle: 'sam-night-shift' },
    );
    expect(subprofile.handle).toBe('sam-night-shift');
  });

  it('suffixes the re-issued handle when the default is taken', async () => {
    isHandleTaken.mockImplementation((_manager: unknown, candidate: string) =>
      Promise.resolve(candidate === 'sam-night-shift'),
    );

    await transfer(
      makeSubprofile({
        status: SubprofileStatus.Published,
        handle: 'robin-night-shift',
      }),
    );

    expect(claimHandle).toHaveBeenCalledWith(
      manager,
      'sam-night-shift-2',
      personaOwner,
    );
  });

  it('skips a name another persona row already stores', async () => {
    manager.exists.mockImplementation(
      (_entity: unknown, options: { where: { handle: string } }) =>
        Promise.resolve(options.where.handle === 'sam-night-shift'),
    );

    await transfer(
      makeSubprofile({
        status: SubprofileStatus.Published,
        handle: 'robin-night-shift',
      }),
    );

    expect(claimHandle).toHaveBeenCalledWith(
      manager,
      'sam-night-shift-2',
      personaOwner,
    );
  });

  it('re-issues a default the 30-char cut shortened', async () => {
    profileSlugs[DEPARTING_ID] = 'a-very-long-departing-creator';
    const shortenedHandle = linkedPersonaHandleCandidate(
      'a-very-long-departing-creator',
      'night-shift',
    );

    try {
      await transfer(
        makeSubprofile({
          status: SubprofileStatus.Published,
          handle: shortenedHandle,
        }),
      );
    } finally {
      profileSlugs[DEPARTING_ID] = 'robin';
    }

    expect(releaseHandle).toHaveBeenCalledWith(
      manager,
      shortenedHandle,
      personaOwner,
      { isForwarding: false },
    );
    expect(claimHandle).toHaveBeenCalledWith(
      manager,
      'sam-night-shift',
      personaOwner,
    );
  });

  it('keeps a custom linked handle that does not carry the departing slug', async () => {
    const subprofile = makeSubprofile({
      status: SubprofileStatus.Published,
      handle: 'night-owl',
    });

    await transfer(subprofile);

    expect(releaseHandle).not.toHaveBeenCalled();
    expect(claimHandle).not.toHaveBeenCalled();
    expect(handleUpdates()).toHaveLength(0);
    expect(subprofile.handle).toBe('night-owl');
  });

  it('stores the re-issued handle on a linked draft and claims nothing', async () => {
    const subprofile = makeSubprofile({
      status: SubprofileStatus.Draft,
      handle: 'robin-night-shift',
    });

    await transfer(subprofile);

    expect(releaseHandle).not.toHaveBeenCalled();
    expect(claimHandle).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { handle: 'sam-night-shift' },
    );
  });

  it('leaves an unlinked persona handle alone', async () => {
    await transfer(
      makeSubprofile({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Published,
        handle: 'after-dark',
      }),
    );

    expect(manager.findOne).not.toHaveBeenCalled();
    expect(releaseHandle).not.toHaveBeenCalled();
    expect(claimHandle).not.toHaveBeenCalled();
    expect(handleUpdates()).toHaveLength(0);
  });

  it('keeps the handle when the successor has no profile to build one from', async () => {
    delete profileSlugs[SUCCESSOR_ID];

    try {
      await transfer(
        makeSubprofile({
          status: SubprofileStatus.Published,
          handle: 'robin-night-shift',
        }),
      );
    } finally {
      profileSlugs[SUCCESSOR_ID] = 'sam';
    }

    expect(releaseHandle).not.toHaveBeenCalled();
    expect(claimHandle).not.toHaveBeenCalled();
    expect(handleUpdates()).toHaveLength(0);
  });

  it('propagates a failed registry write that is not a lost race', async () => {
    claimHandle.mockRejectedValue(new Error('db down'));

    await expect(
      transfer(
        makeSubprofile({
          status: SubprofileStatus.Published,
          handle: 'robin-night-shift',
        }),
      ),
    ).rejects.toThrow('db down');
  });

  it('claims inside a savepoint and tries the next suffix after a lost race', async () => {
    claimHandle.mockImplementation(
      (_manager: unknown, name: string): Promise<void> =>
        name === 'sam-night-shift'
          ? Promise.reject(
              new ConflictException('That handle is already taken'),
            )
          : Promise.resolve(),
    );
    const subprofile = makeSubprofile({
      status: SubprofileStatus.Published,
      handle: 'robin-night-shift',
    });

    await transfer(subprofile);

    expect(manager.transaction).toHaveBeenCalledTimes(2);
    expect(claimHandle).toHaveBeenLastCalledWith(
      manager,
      'sam-night-shift-2',
      personaOwner,
    );
    expect(manager.update).toHaveBeenCalledWith(
      Subprofile,
      { id: SUBPROFILE_ID },
      { handle: 'sam-night-shift-2' },
    );
    expect(subprofile.handle).toBe('sam-night-shift-2');
  });

  it('keeps the old handle and completes the transfer when every attempt loses its race', async () => {
    claimHandle.mockRejectedValue(
      new ConflictException('That handle is already taken'),
    );
    const subprofile = makeSubprofile({
      status: SubprofileStatus.Published,
      handle: 'robin-night-shift',
    });

    const result = await transfer(subprofile);

    expect(result?.newCreatorUserId).toBe(SUCCESSOR_ID);
    expect(claimHandle).toHaveBeenCalledTimes(3);
    expect(handleUpdates()).toHaveLength(0);
    expect(subprofile.handle).toBe('robin-night-shift');
  });

  // A creator who renamed their profile keeps the old slug in the persona
  // handle (profile renames leave persona handles alone).
  it("re-issues a handle carrying the departing creator's former username", async () => {
    formerUsernames = ['kit-marlowe'];

    await transfer(
      makeSubprofile({
        status: SubprofileStatus.Published,
        handle: 'kit-marlowe-night-shift',
      }),
    );

    expect(releaseHandle).toHaveBeenCalledWith(
      manager,
      'kit-marlowe-night-shift',
      personaOwner,
      { isForwarding: false },
    );
    expect(claimHandle).toHaveBeenCalledWith(
      manager,
      'sam-night-shift',
      personaOwner,
    );
  });

  it('stops forwarding older reservations of this persona that carry the departing slug', async () => {
    forwardingPersonaReservations = ['robin-nightshift-old', 'night-owl'];

    await transfer(
      makeSubprofile({
        status: SubprofileStatus.Published,
        handle: 'night-shift-custom',
      }),
    );

    expect(manager.find).toHaveBeenCalledWith(HandleHistory, {
      where: {
        previousOwnerKind: HandleOwnerKind.Subprofile,
        previousOwnerSubprofileId: SUBPROFILE_ID,
        isForwarding: true,
      },
      select: { name: true },
    });
    expect(manager.update).toHaveBeenCalledWith(
      HandleHistory,
      { name: In(['robin-nightshift-old']) },
      { isForwarding: false },
    );
    // The custom current handle stays.
    expect(handleUpdates()).toHaveLength(0);
  });
});
