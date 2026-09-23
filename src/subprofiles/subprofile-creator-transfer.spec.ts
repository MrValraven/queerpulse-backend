import { EntityManager, In, Not } from 'typeorm';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  resolveTransferredSlug,
  transferCreatorWithin,
} from './subprofile-creator-transfer';
import { MAX_SUBPROFILES } from './subprofile-validation';

/**
 * `transferCreatorWithin` against a mocked transaction manager: who succeeds
 * the creator, which slug the persona lands on, and which writes ride the
 * caller's transaction. The Postgres-level behaviour (the upsert, the
 * takedown copy) is asserted through the SQL and parameters it sends.
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

  it('keeps the slug and copies no takedown when the successor has no clash', async () => {
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

  it('copies a takedown from the old slug to the new one when the slug changes', async () => {
    successorPersonas = [{ slug: 'night-shift' }];

    await transfer(makeSubprofile());

    const moderationQueries = queriesMatching('content_moderation');
    expect(moderationQueries).toHaveLength(1);
    const [sql, parameters] = moderationQueries[0] ?? ['', []];
    expect(parameters).toEqual(['night-shift', 'night-shift-2', 'subprofile']);
    // Only a row that still withholds the persona is copied, and a merge
    // onto an existing row keeps every timestamp already set there.
    expect(sql).toContain(
      '"hidden_at" IS NOT NULL OR "removed_at" IS NOT NULL',
    );
    expect(sql).toContain(
      'COALESCE("content_moderation"."hidden_at", EXCLUDED."hidden_at")',
    );
    expect(sql).toContain(
      'COALESCE("content_moderation"."removed_at", EXCLUDED."removed_at")',
    );
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
