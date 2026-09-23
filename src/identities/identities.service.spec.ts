import { QueryFailedError } from 'typeorm';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

function makeUniqueViolation(): QueryFailedError {
  const driverError = Object.assign(new Error('duplicate key'), {
    code: '23505',
  });
  return new QueryFailedError('insert', [], driverError);
}

function makeService() {
  const identities = {
    findOne: jest.fn(),
    // `describeIdentities`/`getByIds` (Task 11) read this; unused by the
    // staffing/act-as tests below, which all stay on `findOne`.
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn((row) => row),
  };
  const listings = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const listingCoManagers = { find: jest.fn().mockResolvedValue([]) };
  const subprofiles = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const subprofileMembers = { find: jest.fn().mockResolvedValue([]) };
  const companies = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const companyTeamMembers = { find: jest.fn().mockResolvedValue([]) };
  // Task 11: `describeIdentities`'s `Profile`-kind branch, unused by every
  // test below except the new `describeIdentities` suite in its own file.
  const profiles = { find: jest.fn().mockResolvedValue([]) };
  const service = new IdentitiesService(
    identities as never,
    listings as never,
    listingCoManagers as never,
    subprofiles as never,
    subprofileMembers as never,
    companies as never,
    companyTeamMembers as never,
    profiles as never,
    {} as never, // participants, unused here (Task 15's mailbox list)
    {} as never, // preferences, unused here (Task 20's attribution switches)
  );
  return {
    service,
    identities,
    listings,
    listingCoManagers,
    subprofiles,
    subprofileMembers,
    companies,
    companyTeamMembers,
    profiles,
  };
}

describe('IdentitiesService.staffUserIds', () => {
  it('returns the listing owner plus only active co-managers', async () => {
    const { service, identities, listings, listingCoManagers } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-1',
      kind: IdentityKind.Listing,
      listingId: 'listing-1',
    });
    listings.findOne.mockResolvedValue({
      id: 'listing-1',
      ownerId: 'owner-user',
    });
    listingCoManagers.find.mockResolvedValue([{ userId: 'comanager-user' }]);

    await expect(service.staffUserIds('identity-1')).resolves.toEqual([
      'owner-user',
      'comanager-user',
    ]);

    expect(listingCoManagers.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { listingId: 'listing-1', status: 'active' },
      }),
    );
  });

  it('returns the persona owner plus its co-owner roster', async () => {
    const { service, identities, subprofiles, subprofileMembers } =
      makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-2',
      kind: IdentityKind.Subprofile,
      subprofileId: 'persona-1',
    });
    subprofiles.findOne.mockResolvedValue({
      id: 'persona-1',
      userId: 'creator-user',
    });
    subprofileMembers.find.mockResolvedValue([
      { userId: 'creator-user' },
      { userId: 'coowner-user' },
    ]);

    await expect(service.staffUserIds('identity-2')).resolves.toEqual([
      'creator-user',
      'coowner-user',
    ]);
  });

  // Final review C1: `leave` deletes a departing creator's roster row and
  // leaves `subprofiles.user_id` as it was. Reading that column as staff let
  // every seat sync, the hourly sweep included, seat them again.
  it('leaves out a persona creator who left the roster', async () => {
    const { service, identities, subprofiles, subprofileMembers } =
      makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-2',
      kind: IdentityKind.Subprofile,
      subprofileId: 'persona-1',
    });
    subprofiles.findOne.mockResolvedValue({
      id: 'persona-1',
      userId: 'departed-creator',
    });
    subprofileMembers.find.mockResolvedValue([{ userId: 'coowner-user' }]);

    await expect(service.staffUserIds('identity-2')).resolves.toEqual([
      'coowner-user',
    ]);
    await expect(
      service.isAllowedToActAs('departed-creator', 'identity-2'),
    ).resolves.toBe(false);
  });

  it('keeps a creator who is still on the roster first, whatever the roster order', async () => {
    const { service, identities, subprofiles, subprofileMembers } =
      makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-2',
      kind: IdentityKind.Subprofile,
      subprofileId: 'persona-1',
    });
    subprofiles.findOne.mockResolvedValue({
      id: 'persona-1',
      userId: 'creator-user',
    });
    subprofileMembers.find.mockResolvedValue([
      { userId: 'coowner-user' },
      { userId: 'creator-user' },
    ]);

    await expect(service.staffUserIds('identity-2')).resolves.toEqual([
      'creator-user',
      'coowner-user',
    ]);
  });

  it('returns just the member for a profile identity', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-3',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });

    await expect(service.staffUserIds('identity-3')).resolves.toEqual([
      'member-user',
    ]);
  });

  it('returns an empty list for an ownerless listing with no co-managers', async () => {
    const { service, identities, listings } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-4',
      kind: IdentityKind.Listing,
      listingId: 'listing-2',
    });
    listings.findOne.mockResolvedValue({ id: 'listing-2', ownerId: null });

    await expect(service.staffUserIds('identity-4')).resolves.toEqual([]);
  });

  /**
   * A listing can be ownerless in two real states: the owner's account was
   * erased, or the listing is house-authored and still awaiting a claim
   * (`Listing.ownerId` is nullable for both). Neither state means the
   * listing has no staff: its active co-managers still answer for it. This
   * is the case a caller reading only the all-empty ownerless test above
   * could miss, since an empty array and a populated one both "work" if the
   * only thing ever inspected is index `[0]`.
   */
  it('returns the active co-managers for an ownerless listing that still has them', async () => {
    const { service, identities, listings, listingCoManagers } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-5',
      kind: IdentityKind.Listing,
      listingId: 'listing-3',
    });
    listings.findOne.mockResolvedValue({ id: 'listing-3', ownerId: null });
    listingCoManagers.find.mockResolvedValue([
      { userId: 'comanager-a' },
      { userId: 'comanager-b' },
    ]);

    await expect(service.staffUserIds('identity-5')).resolves.toEqual([
      'comanager-a',
      'comanager-b',
    ]);
  });

  it('returns an empty list for an unknown identity', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue(null);
    await expect(service.staffUserIds('missing')).resolves.toEqual([]);
  });
});

// Fix round 1: the mailbox seat sync reads staff inside its own transaction,
// and the hourly sweep reads it under a share lock.
describe('IdentitiesService.staffUserIds inside a transaction', () => {
  function makeTransactionManager(repositories: Map<unknown, unknown>) {
    return {
      getRepository: jest.fn((entity: unknown) => {
        const repository = repositories.get(entity);
        if (!repository) {
          throw new Error('Unmodelled repository');
        }
        return repository;
      }),
    };
  }

  it('reads every source through the given manager and leaves the injected repositories untouched', async () => {
    const injected = makeService();
    const transactionIdentities = {
      findOne: jest.fn().mockResolvedValue({
        id: 'identity-1',
        kind: IdentityKind.Listing,
        listingId: 'listing-1',
      }),
    };
    // The transaction's own view: the ownership transfer it has not
    // committed yet already names the new owner.
    const transactionListings = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'listing-1', ownerId: 'new-owner' }),
    };
    const transactionCoManagers = { find: jest.fn().mockResolvedValue([]) };
    const manager = makeTransactionManager(
      new Map<unknown, unknown>([
        [Identity, transactionIdentities],
        [Listing, transactionListings],
        [ListingCoManager, transactionCoManagers],
      ]),
    );

    await expect(
      injected.service.staffUserIds('identity-1', {
        manager: manager as never,
      }),
    ).resolves.toEqual(['new-owner']);

    expect(injected.identities.findOne).not.toHaveBeenCalled();
    expect(injected.listings.findOne).not.toHaveBeenCalled();
    expect(injected.listingCoManagers.find).not.toHaveBeenCalled();
    // No lock unless asked for.
    expect(transactionListings.findOne).toHaveBeenCalledWith({
      where: { id: 'listing-1' },
    });
    expect(transactionCoManagers.find).toHaveBeenCalledWith({
      where: { listingId: 'listing-1', status: 'active' },
    });
  });

  it('locks the listing row, then every seat row of it, FOR SHARE, and keeps only active seats', async () => {
    const { service } = makeService();
    const transactionIdentities = {
      findOne: jest.fn().mockResolvedValue({
        id: 'identity-1',
        kind: IdentityKind.Listing,
        listingId: 'listing-1',
      }),
    };
    const transactionListings = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'listing-1', ownerId: 'owner' }),
    };
    const transactionCoManagers = {
      find: jest.fn().mockResolvedValue([
        { userId: 'active-comanager', status: ListingCoManagerStatus.Active },
        { userId: 'invited-member', status: ListingCoManagerStatus.Invited },
        { userId: 'revoked-member', status: ListingCoManagerStatus.Revoked },
      ]),
    };
    const manager = makeTransactionManager(
      new Map<unknown, unknown>([
        [Identity, transactionIdentities],
        [Listing, transactionListings],
        [ListingCoManager, transactionCoManagers],
      ]),
    );

    await expect(
      service.staffUserIds('identity-1', {
        manager: manager as never,
        shouldLockStaffSource: true,
      }),
    ).resolves.toEqual(['owner', 'active-comanager']);

    expect(transactionListings.findOne).toHaveBeenCalledWith({
      where: { id: 'listing-1' },
      lock: { mode: 'pessimistic_read' },
    });
    // Every seat row, whatever its status, so an invitation turning into
    // access waits for the lock too.
    expect(transactionCoManagers.find).toHaveBeenCalledWith({
      where: { listingId: 'listing-1' },
      lock: { mode: 'pessimistic_read' },
    });
    expect(
      transactionListings.findOne.mock.invocationCallOrder[0],
    ).toBeLessThan(transactionCoManagers.find.mock.invocationCallOrder[0] ?? 0);
  });

  it('locks the persona row FOR SHARE before it reads the roster', async () => {
    const { service } = makeService();
    const transactionIdentities = {
      findOne: jest.fn().mockResolvedValue({
        id: 'identity-2',
        kind: IdentityKind.Subprofile,
        subprofileId: 'persona-1',
      }),
    };
    const transactionSubprofiles = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'persona-1', userId: 'creator-user' }),
    };
    const transactionMembers = {
      find: jest
        .fn()
        .mockResolvedValue([
          { userId: 'creator-user' },
          { userId: 'coowner-user' },
        ]),
    };
    const manager = makeTransactionManager(
      new Map<unknown, unknown>([
        [Identity, transactionIdentities],
        [Subprofile, transactionSubprofiles],
        [SubprofileMember, transactionMembers],
      ]),
    );

    await expect(
      service.staffUserIds('identity-2', {
        manager: manager as never,
        shouldLockStaffSource: true,
      }),
    ).resolves.toEqual(['creator-user', 'coowner-user']);

    expect(transactionSubprofiles.findOne).toHaveBeenCalledWith({
      where: { id: 'persona-1' },
      lock: { mode: 'pessimistic_read' },
    });
    expect(
      transactionSubprofiles.findOne.mock.invocationCallOrder[0],
    ).toBeLessThan(transactionMembers.find.mock.invocationCallOrder[0] ?? 0);
  });

  it('leaves out a departed persona creator under the lock, the read the hourly sweep makes', async () => {
    const { service } = makeService();
    const manager = makeTransactionManager(
      new Map<unknown, unknown>([
        [
          Identity,
          {
            findOne: jest.fn().mockResolvedValue({
              id: 'identity-2',
              kind: IdentityKind.Subprofile,
              subprofileId: 'persona-1',
            }),
          },
        ],
        [
          Subprofile,
          {
            findOne: jest.fn().mockResolvedValue({
              id: 'persona-1',
              userId: 'departed-creator',
            }),
          },
        ],
        [
          SubprofileMember,
          { find: jest.fn().mockResolvedValue([{ userId: 'coowner-user' }]) },
        ],
      ]),
    );

    await expect(
      service.staffUserIds('identity-2', {
        manager: manager as never,
        shouldLockStaffSource: true,
      }),
    ).resolves.toEqual(['coowner-user']);
  });

  it('ignores the lock without a manager, keeping the plain read', async () => {
    const { service, identities, listings, listingCoManagers } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-1',
      kind: IdentityKind.Listing,
      listingId: 'listing-1',
    });
    listings.findOne.mockResolvedValue({ id: 'listing-1', ownerId: 'owner' });

    await service.staffUserIds('identity-1', { shouldLockStaffSource: true });

    expect(listings.findOne).toHaveBeenCalledWith({
      where: { id: 'listing-1' },
    });
    expect(listingCoManagers.find).toHaveBeenCalledWith({
      where: { listingId: 'listing-1', status: 'active' },
    });
  });
});

describe('IdentitiesService.ensureIdentityFor', () => {
  it('returns the existing row when one is found, without attempting a save', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-1',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });

    await expect(
      service.ensureIdentityFor(IdentityKind.Profile, 'member-user'),
    ).resolves.toEqual({
      id: 'identity-1',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });
    expect(identities.save).not.toHaveBeenCalled();
  });

  it('creates and returns a new row when none exists', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue(null);
    identities.save.mockResolvedValue({
      id: 'identity-new',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });

    await expect(
      service.ensureIdentityFor(IdentityKind.Profile, 'member-user'),
    ).resolves.toEqual({
      id: 'identity-new',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });
    expect(identities.save).toHaveBeenCalledTimes(1);
  });

  it('re-queries and returns the winner when the save loses a unique-index race', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'identity-winner',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });
    identities.save.mockRejectedValue(makeUniqueViolation());

    await expect(
      service.ensureIdentityFor(IdentityKind.Profile, 'member-user'),
    ).resolves.toEqual({
      id: 'identity-winner',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });
  });

  it('rethrows any error that is not a unique-index race, unchanged', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue(null);
    const originalError = new Error('connection terminated unexpectedly');
    identities.save.mockRejectedValue(originalError);

    await expect(
      service.ensureIdentityFor(IdentityKind.Profile, 'member-user'),
    ).rejects.toBe(originalError);
  });
});

describe('IdentitiesService.resolveProfileIdentityId', () => {
  it('returns the id of the profile identity it resolved', async () => {
    const { service, identities } = makeService();
    identities.findOne.mockResolvedValue({
      id: 'identity-resolved',
      kind: IdentityKind.Profile,
      userId: 'member-user',
    });

    await expect(service.resolveProfileIdentityId('member-user')).resolves.toBe(
      'identity-resolved',
    );
  });
});
