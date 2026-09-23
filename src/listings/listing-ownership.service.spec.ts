import { EntityManager } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentityMailboxSyncService } from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { ListingOwnershipService } from './listing-ownership.service';
import { ListingCoManagersService } from './listing-co-managers.service';
import { Listing } from './entities/listing.entity';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from './entities/listing-moderation-event.entity';
import {
  ListingOwnerOffer,
  ListingOwnerOfferStatus,
} from './entities/listing-owner-offer.entity';

const TRANSFERRED_AT = new Date('2026-09-20T10:00:00Z');

describe('ListingOwnershipService.transferOwnership', () => {
  const buildListingsRepository = () => ({
    save: jest.fn().mockResolvedValue(undefined),
  });

  /** The `listing_owner_offers` repository the sweep asks `manager` for.
   * `affected` is how many rows were still at `offered` when it ran. */
  const buildOffersRepository = (affected = 0) => ({
    update: jest.fn().mockResolvedValue({ affected }),
  });

  // `withRepository` is what binds the injected `Repository<Listing>` to the
  // caller's transaction, so the fake manager hands back the same repository
  // spy the service was constructed with. `getRepository` serves the
  // stale-offer sweep, which reaches for `ListingOwnerOffer` directly, so
  // that `ListingOwnerOffersService` stays out of the dependency graph of the
  // service it already depends on.
  const buildManager = (
    listings: { save: jest.Mock },
    offers: { update: jest.Mock } = buildOffersRepository(),
  ) => {
    const save = jest.fn().mockResolvedValue(undefined);
    const withRepository = jest.fn().mockReturnValue(listings);
    const getRepository = jest.fn().mockReturnValue(offers);
    return {
      save,
      withRepository,
      getRepository,
    } as unknown as EntityManager & {
      save: jest.Mock;
      withRepository: jest.Mock;
      getRepository: jest.Mock;
    };
  };

  const buildCoManagers = (revoked: number) =>
    ({
      revokeAllForOwnershipTransfer: jest.fn().mockResolvedValue(revoked),
    }) as unknown as ListingCoManagersService & {
      revokeAllForOwnershipTransfer: jest.Mock;
    };

  /** Resolves the listing's mailbox identity for `resyncMailbox` to key off.
   * A fixed id is enough here: every test in this file cares that a transfer
   * asks for a reconcile at all. The identity lookup itself is covered
   * directly by `identity-mailbox-sync.service.spec.ts`. */
  const buildIdentities = () =>
    ({
      ensureIdentityFor: jest
        .fn()
        .mockResolvedValue({ id: 'listing-identity-1' }),
    }) as unknown as IdentitiesService & { ensureIdentityFor: jest.Mock };

  /** What the reconcile reports back, so a test can follow it through the
   * transfer result into `emitTransferChanges`. */
  const reconciledSeatChanges = () => ({
    endedSeats: [{ conversationId: 'conversation-1', userId: 'old-owner' }],
    releasedClaims: [],
    staffingChanges: [
      { identityId: 'listing-identity-1', userId: 'new-owner', isStaff: true },
      { identityId: 'listing-identity-1', userId: 'old-owner', isStaff: false },
    ],
  });

  const buildIdentityMailboxSync = () =>
    ({
      resyncMailbox: jest.fn().mockResolvedValue(reconciledSeatChanges()),
      emitSeatChanges: jest.fn(),
    }) as unknown as IdentityMailboxSyncService & {
      resyncMailbox: jest.Mock;
      emitSeatChanges: jest.Mock;
    };

  /** Every test below constructs the service through this one helper, so
   * adding a fifth dependency later touches one place instead of every test
   * that would otherwise call `new ListingOwnershipService(...)` inline. */
  const buildService = (
    listings: { save: jest.Mock },
    coManagers: ListingCoManagersService,
    identities: IdentitiesService = buildIdentities(),
    identityMailboxSync: IdentityMailboxSyncService = buildIdentityMailboxSync(),
  ) =>
    new ListingOwnershipService(
      listings as never,
      coManagers,
      identities,
      identityMailboxSync,
    );

  const buildListing = (ownerId: string | null): Listing =>
    ({
      id: 'listing-1',
      ownerId,
      contactEmail: 'someone@example.com',
      ownerName: 'Someone',
      ownerBio: 'A bio',
      consentOuting: true,
      consentGuide: true,
    }) as Listing;

  const reasonOf = (manager: { save: jest.Mock }): string | undefined => {
    const [, row] = manager.save.mock.calls[0] as [
      unknown,
      Partial<ListingModerationEvent>,
    ];
    return row.reason ?? undefined;
  };

  it('clears the previous holder personal fields and sets the new owner', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(2);
    const service = buildService(listings, coManagers);
    const listing = buildListing('old-owner');

    const result = await service.transferOwnership(
      manager,
      listing,
      'new-owner',
      'actor-1',
      'Ownership accepted from a staff offer.',
      TRANSFERRED_AT,
    );

    expect(listing.ownerId).toBe('new-owner');
    expect(listing.contactEmail).toBe('');
    expect(listing.ownerName).toBe('');
    expect(listing.ownerBio).toBe('');
    expect(listing.consentOuting).toBe(false);
    expect(listing.consentGuide).toBe(false);
    expect(result.previousOwnerId).toBe('old-owner');
    expect(result.revokedCoManagerCount).toBe(2);
  });

  it('saves the listing through the caller transaction', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(0);
    const service = buildService(listings, coManagers);
    const listing = buildListing('old-owner');

    await service.transferOwnership(
      manager,
      listing,
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(manager.withRepository).toHaveBeenCalledWith(listings);
    expect(listings.save).toHaveBeenCalledWith(listing);
  });

  it('revokes seats on the transferred listing, in the caller transaction, at the transfer instant', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(3);
    const service = buildService(listings, coManagers);

    const result = await service.transferOwnership(
      manager,
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(coManagers.revokeAllForOwnershipTransfer).toHaveBeenCalledTimes(1);
    expect(coManagers.revokeAllForOwnershipTransfer).toHaveBeenCalledWith(
      manager,
      'listing-1',
      TRANSFERRED_AT,
    );
    expect(result.revokedCoManagerCount).toBe(3);
  });

  it('runs the same revoke on a listing that had no owner', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(0);
    const service = buildService(listings, coManagers);

    // An unowned listing reaches here two ways: staff created it, and an owner
    // erased their account. Which seats survive is decided by each seat's
    // `isStaffAttached` provenance inside `revokeAllForOwnershipTransfer`, so
    // this service asks for the revoke either way.
    const result = await service.transferOwnership(
      manager,
      buildListing(null),
      'new-owner',
      'actor-1',
      'Ownership accepted from a staff offer.',
      TRANSFERRED_AT,
    );

    expect(coManagers.revokeAllForOwnershipTransfer).toHaveBeenCalledWith(
      manager,
      'listing-1',
      TRANSFERRED_AT,
    );
    expect(result.revokedCoManagerCount).toBe(0);
    expect(result.previousOwnerId).toBeNull();
  });

  it('reconciles the mailbox against the fresh staff set, in the caller transaction, after the seat revocations', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(1);
    const identities = buildIdentities();
    const identityMailboxSync = buildIdentityMailboxSync();
    const service = buildService(
      listings,
      coManagers,
      identities,
      identityMailboxSync,
    );

    await service.transferOwnership(
      manager,
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(identities.ensureIdentityFor).toHaveBeenCalledWith(
      IdentityKind.Listing,
      'listing-1',
    );
    expect(identityMailboxSync.resyncMailbox).toHaveBeenCalledWith(
      'listing-identity-1',
      manager,
      { shouldDeferEmission: true },
    );
    // The reconcile reads post-revocation state, so it must be asked for
    // strictly after the co-manager seats have already been revoked. Both
    // calls are first asserted to have happened at all, via an explicit
    // thrown error, so an implementation that drops the resync call entirely
    // fails loudly here instead of the comparison silently passing on two
    // `undefined`s.
    const revokeOrder =
      coManagers.revokeAllForOwnershipTransfer.mock.invocationCallOrder[0];
    const resyncOrder =
      identityMailboxSync.resyncMailbox.mock.invocationCallOrder[0];
    if (revokeOrder === undefined || resyncOrder === undefined) {
      throw new Error(
        'Expected both the seat revocation and the mailbox resync to have been called',
      );
    }
    expect(resyncOrder).toBeGreaterThan(revokeOrder);
  });

  it('holds the reconcile changes back on the result and emits nothing while the caller transaction is open', async () => {
    const listings = buildListingsRepository();
    const identityMailboxSync = buildIdentityMailboxSync();
    const service = buildService(
      listings,
      buildCoManagers(1),
      buildIdentities(),
      identityMailboxSync,
    );

    const result = await service.transferOwnership(
      buildManager(listings),
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(result.seatChanges).toEqual(reconciledSeatChanges());
    expect(identityMailboxSync.emitSeatChanges).not.toHaveBeenCalled();
  });

  it('emitTransferChanges sends the held-back reconcile changes', async () => {
    const listings = buildListingsRepository();
    const identityMailboxSync = buildIdentityMailboxSync();
    const service = buildService(
      listings,
      buildCoManagers(1),
      buildIdentities(),
      identityMailboxSync,
    );
    const result = await service.transferOwnership(
      buildManager(listings),
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    service.emitTransferChanges(result);

    expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledTimes(1);
    expect(identityMailboxSync.emitSeatChanges).toHaveBeenCalledWith(
      reconciledSeatChanges(),
    );
  });

  it('writes one ownership_transferred audit row carrying the reason prefix', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(0);
    const service = buildService(listings, coManagers);

    await service.transferOwnership(
      manager,
      buildListing(null),
      'new-owner',
      'actor-1',
      'Ownership accepted from a staff offer.',
      TRANSFERRED_AT,
    );

    expect(manager.save).toHaveBeenCalledTimes(1);
    const [entity, row] = manager.save.mock.calls[0] as [
      unknown,
      Partial<ListingModerationEvent>,
    ];
    expect(entity).toBe(ListingModerationEvent);
    expect(row.listingId).toBe('listing-1');
    expect(row.action).toBe(ListingModerationAction.OwnershipTransferred);
    expect(row.actorId).toBe('actor-1');
    expect(row.fromStatus).toBeNull();
    expect(row.toStatus).toBeNull();
    expect(row.reason).toContain('Ownership accepted from a staff offer.');
  });

  // The three seat sentences below are the exact strings the claim path has
  // written since `ownership_transferred` was introduced. They are pinned
  // because the audit trail is read as history, so a reworded sentence changes
  // what the older rows appear to mean.
  it('keeps the zero-seat sentence when a displaced owner had no co-managers', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(0);
    const service = buildService(listings, coManagers);

    await service.transferOwnership(
      manager,
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(reasonOf(manager)).toBe(
      'Ownership transferred on an approved claim. The listing had no co-managers to revoke.',
    );
  });

  it('keeps the singular seat sentence for one revoked seat', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(1);
    const service = buildService(listings, coManagers);

    await service.transferOwnership(
      manager,
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      'Ownership transferred on an approved claim.',
      TRANSFERRED_AT,
    );

    expect(reasonOf(manager)).toBe(
      'Ownership transferred on an approved claim. 1 co-manager seat was revoked by the transfer.',
    );
  });

  it('keeps the plural seat sentence for several revoked seats', async () => {
    const listings = buildListingsRepository();
    const manager = buildManager(listings);
    const coManagers = buildCoManagers(3);
    const service = buildService(listings, coManagers);

    await service.transferOwnership(
      manager,
      buildListing('old-owner'),
      'new-owner',
      'actor-1',
      "Ownership transferred on an approved claim. Claimant's note: I run it.",
      TRANSFERRED_AT,
    );

    expect(reasonOf(manager)).toBe(
      "Ownership transferred on an approved claim. Claimant's note: I run it. " +
        '3 co-manager seats were revoked by the transfer.',
    );
  });

  // THE STALE-OFFER SWEEP, from both directions.
  //
  // A listing can be offered to one member and claimed by another while that
  // offer is still open. Whichever of the two lands first, the other row must
  // stop occupying the single open-offer slot the partial unique index
  // permits, and must stop being acceptable if `owner_id` later returns to
  // NULL through owner erasure.
  describe('the open owner offer left behind by a transfer', () => {
    it('revokes an offer still at offered when a claim approval hands the listing over', async () => {
      const listings = buildListingsRepository();
      const offers = buildOffersRepository(1);
      const manager = buildManager(listings, offers);
      const service = buildService(listings, buildCoManagers(0));

      await service.transferOwnership(
        manager,
        buildListing(null),
        'claimant-1',
        'moderator-1',
        'Ownership transferred on an approved claim.',
        TRANSFERRED_AT,
      );

      // Reached through the caller's own manager, so the sweep commits or
      // rolls back with the reassignment.
      expect(manager.getRepository).toHaveBeenCalledWith(ListingOwnerOffer);
      expect(offers.update).toHaveBeenCalledTimes(1);
      expect(offers.update).toHaveBeenCalledWith(
        {
          listingId: 'listing-1',
          status: ListingOwnerOfferStatus.Offered,
        },
        {
          status: ListingOwnerOfferStatus.Revoked,
          respondedAt: TRANSFERRED_AT,
        },
      );
    });

    // The half of the accept-path guarantee that lives in THIS file is the
    // predicate: the sweep narrows by status, so any row already out of
    // `offered` is beyond its reach. The other half is call ORDER inside
    // `ListingOwnerOffersService.respond`, which flips its own row before it
    // calls in here. This service cannot observe that, and a test here
    // claiming to cover it would pass whatever order `respond` used, so it is
    // asserted where it happens, by "flips its own offer row out of offered
    // before it calls transferOwnership" in
    // `listing-owner-offers.service.spec.ts`.
    it('narrows the sweep by status, so a row already out of offered is untouched', async () => {
      const listings = buildListingsRepository();
      const offers = buildOffersRepository(0);
      const manager = buildManager(listings, offers);
      const service = buildService(listings, buildCoManagers(0));

      await service.transferOwnership(
        manager,
        buildListing(null),
        'offeree-1',
        'offeree-1',
        'Ownership accepted from a staff offer.',
        TRANSFERRED_AT,
      );

      // A sweep keyed on `listingId` alone would rewrite an accept that had
      // just committed, which is why the status belongs in the predicate.
      const [predicate] = offers.update.mock.calls[0] as [
        { listingId: string; status: ListingOwnerOfferStatus },
        unknown,
      ];
      expect(predicate).toEqual({
        listingId: 'listing-1',
        status: ListingOwnerOfferStatus.Offered,
      });
      // Zero swept rows is a normal outcome and completes the transfer.
      expect(listings.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledTimes(1);
    });
  });
});
