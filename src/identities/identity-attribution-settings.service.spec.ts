import { ForbiddenException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { ListingCoManagerStatus } from '../listings/entities/listing-co-manager.entity';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentityAttributionService } from './identity-attribution.service';
import { IdentityAttributionSettingsService } from './identity-attribution-settings.service';
import { IdentitiesService } from './identities.service';

/**
 * Task 20: `IdentityAttributionSettingsService`, behind `GET`/`PATCH
 * /identities/:identityId/attribution` and `PUT
 * /identities/:identityId/staff-preferences/me`. Every dependency on
 * `IdentitiesService` is stubbed directly except where a test needs the
 * resolver behavioural link (`IdentityAttributionService`), where a small
 * real `IdentitiesService` backs both services from the same in-memory
 * tables, the same way `list-mailboxes.spec.ts` backs `IdentitiesService`
 * itself.
 */

type Row = Record<string, unknown>;

function matchesValue(expected: unknown, actual: unknown): boolean {
  if (expected instanceof FindOperator) {
    if (expected.type === 'in') {
      return (expected.value as unknown[]).includes(actual);
    }
    throw new Error(`unsupported operator ${expected.type}`);
  }
  return expected === actual;
}

function matchesWhere(where: Row | undefined, row: Row): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([column, expected]) =>
    matchesValue(expected, row[column]),
  );
}

/** A plain in-memory table, `find`/`findOne`/`update` over `rows`. */
function makeSimpleTable(rows: Row[]) {
  return {
    rows,
    find: jest.fn((options?: { where?: Row }) =>
      Promise.resolve(rows.filter((row) => matchesWhere(options?.where, row))),
    ),
    findOne: jest.fn((options?: { where?: Row }) =>
      Promise.resolve(
        rows.find((row) => matchesWhere(options?.where, row)) ?? null,
      ),
    ),
    update: jest.fn((id: string, partial: Row) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) {
        Object.assign(row, partial);
      }
      return Promise.resolve({ affected: row ? 1 : 0 });
    }),
  };
}

/**
 * The `identity_staff_preferences` table, with `query` simulating the real
 * `INSERT ... ON CONFLICT ... DO UPDATE` upsert this service issues, so a
 * test can prove no `findOne`-then-`save` race is possible.
 */
function makePreferencesTable(rows: Row[]) {
  let nextId = 1;
  return {
    rows,
    findOne: jest.fn((options?: { where?: Row }) =>
      Promise.resolve(
        rows.find((row) => matchesWhere(options?.where, row)) ?? null,
      ),
    ),
    find: jest.fn((options?: { where?: Row }) =>
      Promise.resolve(rows.filter((row) => matchesWhere(options?.where, row))),
    ),
    save: jest.fn(),
    query: jest.fn((_sql: string, params: unknown[]) => {
      const [identityId, userId, shouldAllowNaming] = params as [
        string,
        string,
        boolean,
      ];
      const existing = rows.find(
        (row) => row.identityId === identityId && row.userId === userId,
      );
      if (existing) {
        existing.shouldAllowNaming = shouldAllowNaming;
      } else {
        rows.push({
          id: `pref-${nextId++}`,
          identityId,
          userId,
          shouldAllowNaming,
        });
      }
      return Promise.resolve([]);
    }),
  };
}

/** A stubbed `IdentitiesService`, only the four methods this service consumes. */
function makeIdentities(
  overrides: Partial<{
    getById: jest.Mock;
    isAllowedToActAs: jest.Mock;
    assertMayActAs: jest.Mock;
    ownerUserIdOf: jest.Mock;
  }> = {},
) {
  return {
    getById: jest.fn(),
    isAllowedToActAs: jest.fn(),
    assertMayActAs: jest.fn().mockResolvedValue(undefined),
    ownerUserIdOf: jest.fn(),
    ...overrides,
  };
}

describe('IdentityAttributionSettingsService.getAttribution', () => {
  it("returns the identity's switch, the caller's absent-row default true, and isOwner for a co-manager versus the owner", async () => {
    const identityRow: Row = {
      id: 'cafe-identity',
      kind: IdentityKind.Listing,
      listingId: 'cafe',
      shouldShowStaffNames: true,
    };
    const identities = makeIdentities({
      isAllowedToActAs: jest.fn().mockResolvedValue(true),
      getById: jest.fn().mockResolvedValue(identityRow),
      ownerUserIdOf: jest
        .fn()
        .mockImplementation((identity: Identity) =>
          Promise.resolve(
            identity.id === 'cafe-identity' ? 'owner-user' : null,
          ),
        ),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([identityRow]) as never,
      makePreferencesTable([]) as never,
    );

    await expect(
      service.getAttribution('co-manager-user', 'cafe-identity'),
    ).resolves.toEqual({
      shouldShowStaffNames: true,
      shouldAllowMyName: true,
      isOwner: false,
    });
    await expect(
      service.getAttribution('owner-user', 'cafe-identity'),
    ).resolves.toEqual({
      shouldShowStaffNames: true,
      shouldAllowMyName: true,
      isOwner: true,
    });
  });

  it('refuses a non-staff caller and a caller naming a random identity with the identical IDENTITY_NOT_STAFF body', async () => {
    const identities = makeIdentities({
      isAllowedToActAs: jest.fn().mockResolvedValue(false),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([]) as never,
      makePreferencesTable([]) as never,
    );

    const nonStaffError = await service
      .getAttribution('stranger-user', 'cafe-identity')
      .catch((error: unknown) => error);
    const unknownIdentityError = await service
      .getAttribution('stranger-user', 'a0000000-0000-4000-8000-000000000000')
      .catch((error: unknown) => error);

    expect(nonStaffError).toMatchObject({
      response: { code: 'IDENTITY_NOT_STAFF' },
    });
    expect((nonStaffError as { response: unknown }).response).toEqual(
      (unknownIdentityError as { response: unknown }).response,
    );
  });

  it('refuses a profile identity with IDENTITY_NOT_A_MAILBOX, checked only after the staff check passes', async () => {
    const profileIdentity: Row = {
      id: 'profile-identity',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    };
    const identities = makeIdentities({
      isAllowedToActAs: jest.fn().mockResolvedValue(true),
      getById: jest.fn().mockResolvedValue(profileIdentity),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([profileIdentity]) as never,
      makePreferencesTable([]) as never,
    );

    await expect(
      service.getAttribution('member-user', 'profile-identity'),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_NOT_A_MAILBOX' } });
  });
});

describe('IdentityAttributionSettingsService.updateOwnerSwitch', () => {
  it('flips the column for the owner, and refuses a co-manager with IDENTITY_NOT_OWNER while changing nothing', async () => {
    const identityRow: Row = {
      id: 'cafe-identity',
      kind: IdentityKind.Listing,
      listingId: 'cafe',
      shouldShowStaffNames: true,
    };
    const identityRepository = makeSimpleTable([identityRow]);
    const identities = makeIdentities({
      assertMayActAs: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue(identityRow),
      ownerUserIdOf: jest.fn().mockResolvedValue('owner-user'),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      identityRepository as never,
      makePreferencesTable([]) as never,
    );

    const ownerResult = await service.updateOwnerSwitch(
      'owner-user',
      'cafe-identity',
      false,
    );
    expect(ownerResult.shouldShowStaffNames).toBe(false);
    expect(identityRow.shouldShowStaffNames).toBe(false);

    identityRow.shouldShowStaffNames = true;
    await expect(
      service.updateOwnerSwitch('co-manager-user', 'cafe-identity', false),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_NOT_OWNER' } });
    expect(identityRow.shouldShowStaffNames).toBe(true);
  });

  it('refuses every staff member on an ownerless listing', async () => {
    const identityRow: Row = {
      id: 'cafe-identity',
      kind: IdentityKind.Listing,
      listingId: 'cafe',
      shouldShowStaffNames: true,
    };
    const identities = makeIdentities({
      assertMayActAs: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue(identityRow),
      // Ownerless: the listing's owner column was erased, co-managers remain.
      ownerUserIdOf: jest.fn().mockResolvedValue(null),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([identityRow]) as never,
      makePreferencesTable([]) as never,
    );

    await expect(
      service.updateOwnerSwitch('co-manager-user', 'cafe-identity', false),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_NOT_OWNER' } });
    expect(identityRow.shouldShowStaffNames).toBe(true);
  });
});

describe('IdentityAttributionSettingsService.updateOwnStaffPreference', () => {
  it('upserts in one statement: false then true leaves exactly one row holding true, with no findOne-then-save race', async () => {
    const identityRow: Row = {
      id: 'cafe-identity',
      kind: IdentityKind.Listing,
      listingId: 'cafe',
      shouldShowStaffNames: true,
    };
    const preferences = makePreferencesTable([]);
    const identities = makeIdentities({
      assertMayActAs: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue(identityRow),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([identityRow]) as never,
      preferences as never,
    );

    await service.updateOwnStaffPreference(
      'co-manager-user',
      'cafe-identity',
      false,
    );
    await service.updateOwnStaffPreference(
      'co-manager-user',
      'cafe-identity',
      true,
    );

    expect(preferences.rows).toHaveLength(1);
    expect(preferences.rows[0]!.shouldAllowNaming).toBe(true);
    expect(preferences.query).toHaveBeenCalledTimes(2);
    expect(preferences.findOne).not.toHaveBeenCalled();
    expect(preferences.save).not.toHaveBeenCalled();
  });
});

describe('a persona moderation removed', () => {
  it('lets GET succeed, and refuses PATCH and PUT with IDENTITY_REMOVED', async () => {
    const removedPersonaIdentity: Row = {
      id: 'persona-identity',
      kind: IdentityKind.Subprofile,
      subprofileId: 'persona-1',
      shouldShowStaffNames: true,
    };
    const removedRefusal = {
      code: 'IDENTITY_REMOVED',
      message: 'This persona was removed and cannot send messages',
    };
    const identities = makeIdentities({
      isAllowedToActAs: jest.fn().mockResolvedValue(true),
      getById: jest.fn().mockResolvedValue(removedPersonaIdentity),
      assertMayActAs: jest
        .fn()
        .mockRejectedValue(new ForbiddenException(removedRefusal)),
      ownerUserIdOf: jest.fn().mockResolvedValue('persona-owner-user'),
    });
    const service = new IdentityAttributionSettingsService(
      identities as never,
      makeSimpleTable([removedPersonaIdentity]) as never,
      makePreferencesTable([]) as never,
    );

    await expect(
      service.getAttribution('colleague-user', 'persona-identity'),
    ).resolves.toEqual({
      shouldShowStaffNames: true,
      shouldAllowMyName: true,
      isOwner: false,
    });
    await expect(
      service.updateOwnerSwitch(
        'persona-owner-user',
        'persona-identity',
        false,
      ),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_REMOVED' } });
    await expect(
      service.updateOwnStaffPreference(
        'colleague-user',
        'persona-identity',
        false,
      ),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_REMOVED' } });
  });
});

describe('the resolver behavioural link', () => {
  /**
   * `IdentityAttributionSettingsService` and `IdentityAttributionService`
   * share the SAME identity and preference tables, exactly as they share the
   * same Postgres rows in production, so a write through the settings
   * service is provably visible to the resolver's next read.
   */
  function makeSharedFixture() {
    const identityRow: Row = {
      id: 'cafe-identity',
      kind: IdentityKind.Listing,
      listingId: 'cafe',
      subprofileId: null,
      companyId: null,
      userId: null,
      shouldShowStaffNames: true,
    };
    const identities = makeSimpleTable([identityRow]);
    const listings = makeSimpleTable([{ id: 'cafe', ownerId: 'owner-user' }]);
    const listingCoManagers = makeSimpleTable([
      {
        listingId: 'cafe',
        userId: 'co-manager-user',
        status: ListingCoManagerStatus.Active,
      },
    ]);
    const subprofiles = makeSimpleTable([]);
    const subprofileMembers = makeSimpleTable([]);
    const companies = makeSimpleTable([]);
    const companyTeamMembers = makeSimpleTable([]);
    const profiles = makeSimpleTable([]);
    const identitiesService = new IdentitiesService(
      identities as never,
      listings as never,
      listingCoManagers as never,
      subprofiles as never,
      subprofileMembers as never,
      companies as never,
      companyTeamMembers as never,
      profiles as never,
      {} as never, // participants, unused here
      {} as never, // preferences (Task 20's mailbox-list field), unused here
    );
    const preferences = makePreferencesTable([]);
    const settingsService = new IdentityAttributionSettingsService(
      identitiesService,
      identities as never,
      preferences as never,
    );
    const attributionService = new IdentityAttributionService(
      preferences as never,
      identitiesService,
    );
    return { identityRow, settingsService, attributionService };
  }

  it('turning the owner switch off through the new service hides the name from a customer, and a colleague still sees it', async () => {
    const { settingsService, attributionService } = makeSharedFixture();

    await settingsService.updateOwnerSwitch(
      'owner-user',
      'cafe-identity',
      false,
    );

    const forCustomer = await attributionService.buildStaffNameResolver(
      ['cafe-identity'],
      'customer-user',
    );
    expect(
      forCustomer.resolve('cafe-identity', 'co-manager-user', 'Tiago'),
    ).toBeNull();

    const forColleague = await attributionService.buildStaffNameResolver(
      ['cafe-identity'],
      'co-manager-user',
    );
    expect(
      forColleague.resolve('cafe-identity', 'co-manager-user', 'Tiago'),
    ).toBe('Tiago');
  });

  it("a staff opt-out through the new service hides that staff member's name from a customer, and a colleague still sees it", async () => {
    const { settingsService, attributionService } = makeSharedFixture();

    await settingsService.updateOwnStaffPreference(
      'co-manager-user',
      'cafe-identity',
      false,
    );

    const forCustomer = await attributionService.buildStaffNameResolver(
      ['cafe-identity'],
      'customer-user',
    );
    expect(
      forCustomer.resolve('cafe-identity', 'co-manager-user', 'Tiago'),
    ).toBeNull();

    const forColleague = await attributionService.buildStaffNameResolver(
      ['cafe-identity'],
      'co-manager-user',
    );
    expect(
      forColleague.resolve('cafe-identity', 'co-manager-user', 'Tiago'),
    ).toBe('Tiago');
  });
});
