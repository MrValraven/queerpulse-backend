import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentityAttributionService } from './identity-attribution.service';

function businessIdentity(shouldShowStaffNames: boolean): Identity {
  return {
    id: 'identity-1',
    kind: IdentityKind.Listing,
    listingId: 'listing-1',
    shouldShowStaffNames,
  } as Identity;
}

function makeService(shouldAllowNaming: boolean | null, staff: string[]) {
  const preferences = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        shouldAllowNaming === null ? null : { shouldAllowNaming },
      ),
  };
  const identities = { staffUserIds: jest.fn().mockResolvedValue(staff) };
  return new IdentityAttributionService(
    preferences as never,
    identities as never,
  );
}

describe('IdentityAttributionService.resolveStaffFirstName', () => {
  const base = {
    senderUserId: 'staff-user',
    senderFirstName: 'Tiago',
    readerUserId: 'customer',
  };

  it('names the staff member when both switches allow it', async () => {
    const service = makeService(null, ['staff-user']);
    await expect(
      service.resolveStaffFirstName({
        identity: businessIdentity(true),
        ...base,
      }),
    ).resolves.toBe('Tiago');
  });

  it('returns null when the mailbox switch is off', async () => {
    const service = makeService(null, ['staff-user']);
    await expect(
      service.resolveStaffFirstName({
        identity: businessIdentity(false),
        ...base,
      }),
    ).resolves.toBeNull();
  });

  it('returns null when the staff member declined naming', async () => {
    const service = makeService(false, ['staff-user']);
    await expect(
      service.resolveStaffFirstName({
        identity: businessIdentity(true),
        ...base,
      }),
    ).resolves.toBeNull();
  });

  it('always names the sender for a reader who is staff of the same mailbox', async () => {
    const service = makeService(false, ['staff-user', 'colleague']);
    await expect(
      service.resolveStaffFirstName({
        identity: businessIdentity(false),
        ...base,
        readerUserId: 'colleague',
      }),
    ).resolves.toBe('Tiago');
  });

  it('returns null for a profile identity, where the sender is already the member', async () => {
    const service = makeService(null, ['staff-user']);
    const profile = {
      id: 'identity-2',
      kind: IdentityKind.Profile,
      userId: 'staff-user',
      shouldShowStaffNames: true,
    } as Identity;
    await expect(
      service.resolveStaffFirstName({ identity: profile, ...base }),
    ).resolves.toBeNull();
  });
});

/**
 * `Repository.findOne`/`.find`/`staffUserIds` mocks that also record how many
 * times each was called, so `buildStaffNameResolver`'s tests can assert on
 * call counts directly, straight from the mock, instead of inferring them
 * from timing.
 */
function makeResolverFixture(options: {
  identities: Record<string, { shouldShowStaffNames: boolean }>;
  staffByIdentityId: Record<string, string[]>;
  preferenceRows: {
    identityId: string;
    userId: string;
    shouldAllowNaming: boolean;
  }[];
}) {
  const {
    identities: identityFlags,
    staffByIdentityId,
    preferenceRows,
  } = options;
  const preferences = {
    // Mirrors the same `preferenceRows` fixture data `.find` reads, so a test
    // comparing `resolveStaffFirstName` (which calls `.findOne`) against
    // `buildStaffNameResolver` (which calls `.find`) is comparing the two
    // methods against the same one shared fixture, kept in sync on purpose,
    // instead of two separate mocks that merely happen to share a name.
    findOne: jest.fn(
      async ({ where }: { where: { identityId: string; userId: string } }) =>
        preferenceRows.find(
          (row) =>
            row.identityId === where.identityId && row.userId === where.userId,
        ) ?? null,
    ),
    find: jest
      .fn()
      .mockResolvedValue(preferenceRows.map((row) => ({ ...row }))),
  };
  const identities = {
    getById: jest.fn(async (identityId: string) => {
      const flags = identityFlags[identityId];
      if (!flags) {
        return null;
      }
      return {
        id: identityId,
        kind: IdentityKind.Listing,
        listingId: `listing-${identityId}`,
        shouldShowStaffNames: flags.shouldShowStaffNames,
      } as Identity;
    }),
    staffUserIds: jest
      .fn()
      .mockImplementation(
        async (identityId: string) => staffByIdentityId[identityId] ?? [],
      ),
  };
  const service = new IdentityAttributionService(
    preferences as never,
    identities as never,
  );
  return { service, preferences, identities };
}

describe('IdentityAttributionService.buildStaffNameResolver', () => {
  const IDENTITY_BOTH_ON = 'identity-both-on';
  const IDENTITY_MAILBOX_OFF = 'identity-mailbox-off';
  const IDENTITY_STAFF_DECLINED = 'identity-staff-declined';

  it('answers identically to resolveStaffFirstName across all four cases', async () => {
    // Case A: both switches on. Case B: mailbox switch off. Case C: staff
    // declined naming. All three read from a customer (not staff).
    const { service } = makeResolverFixture({
      identities: {
        [IDENTITY_BOTH_ON]: { shouldShowStaffNames: true },
        [IDENTITY_MAILBOX_OFF]: { shouldShowStaffNames: false },
        [IDENTITY_STAFF_DECLINED]: { shouldShowStaffNames: true },
      },
      staffByIdentityId: {
        [IDENTITY_BOTH_ON]: ['staff-user'],
        [IDENTITY_MAILBOX_OFF]: ['staff-user'],
        [IDENTITY_STAFF_DECLINED]: ['staff-user'],
      },
      preferenceRows: [
        {
          identityId: IDENTITY_STAFF_DECLINED,
          userId: 'staff-user',
          shouldAllowNaming: false,
        },
      ],
    });
    const resolver = await service.buildStaffNameResolver(
      [IDENTITY_BOTH_ON, IDENTITY_MAILBOX_OFF, IDENTITY_STAFF_DECLINED],
      'customer',
    );

    const cases: { identityId: string; shouldShowStaffNames: boolean }[] = [
      { identityId: IDENTITY_BOTH_ON, shouldShowStaffNames: true },
      { identityId: IDENTITY_MAILBOX_OFF, shouldShowStaffNames: false },
      { identityId: IDENTITY_STAFF_DECLINED, shouldShowStaffNames: true },
    ];
    for (const { identityId, shouldShowStaffNames } of cases) {
      const identity = {
        id: identityId,
        kind: IdentityKind.Listing,
        listingId: `listing-${identityId}`,
        shouldShowStaffNames,
      } as Identity;
      const expected = await service.resolveStaffFirstName({
        identity,
        senderUserId: 'staff-user',
        senderFirstName: 'Tiago',
        readerUserId: 'customer',
      });
      expect(resolver.resolve(identityId, 'staff-user', 'Tiago')).toBe(
        expected,
      );
    }
    // Case D: reader is a colleague of the mailbox, always named, regardless
    // of either switch. Built as its own resolver since the reader differs.
    const colleagueService = makeResolverFixture({
      identities: { [IDENTITY_MAILBOX_OFF]: { shouldShowStaffNames: false } },
      staffByIdentityId: {
        [IDENTITY_MAILBOX_OFF]: ['staff-user', 'colleague'],
      },
      preferenceRows: [],
    });
    const colleagueResolver =
      await colleagueService.service.buildStaffNameResolver(
        [IDENTITY_MAILBOX_OFF],
        'colleague',
      );
    const colleagueExpected =
      await colleagueService.service.resolveStaffFirstName({
        identity: {
          id: IDENTITY_MAILBOX_OFF,
          kind: IdentityKind.Listing,
          listingId: 'listing-x',
          shouldShowStaffNames: false,
        } as Identity,
        senderUserId: 'staff-user',
        senderFirstName: 'Tiago',
        readerUserId: 'colleague',
      });
    expect(colleagueExpected).toBe('Tiago');
    expect(
      colleagueResolver.resolve(IDENTITY_MAILBOX_OFF, 'staff-user', 'Tiago'),
    ).toBe(colleagueExpected);
  });

  it('loads preferences in one query for several identities', async () => {
    const IDENTITY_A = 'identity-a';
    const IDENTITY_B = 'identity-b';
    const { service, preferences } = makeResolverFixture({
      identities: {
        [IDENTITY_A]: { shouldShowStaffNames: true },
        [IDENTITY_B]: { shouldShowStaffNames: true },
      },
      staffByIdentityId: {
        [IDENTITY_A]: ['staff-a'],
        [IDENTITY_B]: ['staff-b'],
      },
      preferenceRows: [],
    });

    await service.buildStaffNameResolver([IDENTITY_A, IDENTITY_B], 'customer');

    expect(preferences.find).toHaveBeenCalledTimes(1);
  });

  it('makes no further queries once built', async () => {
    const IDENTITY = 'identity-fixed-cost';
    const { service, preferences, identities } = makeResolverFixture({
      identities: { [IDENTITY]: { shouldShowStaffNames: true } },
      staffByIdentityId: { [IDENTITY]: ['staff-user'] },
      preferenceRows: [],
    });

    const resolver = await service.buildStaffNameResolver(
      [IDENTITY],
      'customer',
    );
    preferences.find.mockClear();
    preferences.findOne.mockClear();
    identities.getById.mockClear();
    identities.staffUserIds.mockClear();

    for (let i = 0; i < 20; i++) {
      resolver.resolve(IDENTITY, 'staff-user', 'Tiago');
    }

    expect(preferences.find).not.toHaveBeenCalled();
    expect(preferences.findOne).not.toHaveBeenCalled();
    expect(identities.getById).not.toHaveBeenCalled();
    expect(identities.staffUserIds).not.toHaveBeenCalled();
  });

  it('returns null for a blank sender name', async () => {
    const IDENTITY = 'identity-blank-check';
    const { service } = makeResolverFixture({
      identities: { [IDENTITY]: { shouldShowStaffNames: true } },
      staffByIdentityId: { [IDENTITY]: [] },
      preferenceRows: [],
    });
    const resolver = await service.buildStaffNameResolver(
      [IDENTITY],
      'customer',
    );

    expect(resolver.resolve(IDENTITY, 'staff-user', '')).toBeNull();
    expect(resolver.resolve(IDENTITY, 'staff-user', '   ')).toBeNull();
  });
});
