import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ListingOwnerOffer,
  ListingOwnerOfferStatus,
} from './entities/listing-owner-offer.entity';
import { Listing } from './entities/listing.entity';
import { ListingOwnerOffersService } from './listing-owner-offers.service';
import { ListingOwnershipService } from './listing-ownership.service';

/**
 * THE OFFER LIFECYCLE: staff nominate a member as the owner of a listing that
 * has none, and the member answers.
 *
 * Two properties carry the whole feature and both are asserted here. Nobody's
 * name reaches a public page about a queer business without their accept, and
 * `listings.owner_id` is written in exactly one place, by the shared transfer
 * helper, inside the accepting member's own transaction.
 */

const ADMIN_ID = 'admin-1';
const OFFEREE_ID = 'member-1';
const OTHER_MEMBER_ID = 'member-2';
const OFFEREE_SLUG = 'ana-ribeiro';
const LISTING_ID = 'listing-1';
const LISTING_REF = 'QPL-2026-0001';
const OPEN_OFFER_UNIQUE_INDEX = 'UQ_listing_owner_offers_open';

/**
 * Only the columns this service reads. A full `Listing` literal runs past 100
 * fields and every one of them would be noise here: the offer path touches
 * `id`, `ref`, `slug`, `name`, `ownerId` and the baseline stamp, and nothing
 * else.
 */
const listingFixture = (overrides: Partial<Listing> = {}): Listing =>
  ({
    id: LISTING_ID,
    ref: LISTING_REF,
    slug: 'lux-cafe',
    name: 'Lux Café',
    ownerId: null,
    affirmingBaselineAcceptedAt: null,
    ...overrides,
  }) as unknown as Listing;

const offerFixture = (
  overrides: Partial<ListingOwnerOffer> = {},
): ListingOwnerOffer =>
  ({
    id: 'offer-1',
    listingId: LISTING_ID,
    offereeId: OFFEREE_ID,
    offeredByUserId: ADMIN_ID,
    note: null,
    status: ListingOwnerOfferStatus.Offered,
    offeredAt: new Date('2026-09-01T10:00:00.000Z'),
    respondedAt: null,
    ...overrides,
  }) as unknown as ListingOwnerOffer;

/** What the shared transfer hands back, including the mailbox changes it
 * held back for the caller to send after commit. */
const transferResult = () => ({
  previousOwnerId: null,
  revokedCoManagerCount: 0,
  seatChanges: {
    endedSeats: [],
    releasedClaims: [],
    staffingChanges: [
      { identityId: 'listing-identity-1', userId: OFFEREE_ID, isStaff: true },
    ],
  },
});

/** A Postgres unique violation on the partial open-offer index, in the shape
 * `isUniqueViolation` reads (SQLSTATE on the wrapped driver error). */
const openOfferUniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), {
    driverError: { code: '23505', constraint: OPEN_OFFER_UNIQUE_INDEX },
  });

/** `MemberLookup.userIdForSlug` runs through a query builder, so the profiles
 * double answers with one. An empty result is how a suspended or waitlisted
 * member reads, because the builder inner-joins on `u.status = 'active'`. */
const profileQueryBuilder = (rows: Array<{ slug: string; userId: string }>) => {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ['innerJoin', 'where']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  return builder;
};

describe('ListingOwnerOffersService', () => {
  let service: ListingOwnerOffersService;
  let offers: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let listings: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock };
  let profiles: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let ownership: {
    transferOwnership: jest.Mock;
    emitTransferChanges: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let notifications: { create: jest.Mock };

  /** Both repositories reach the service through the transaction's manager,
   * so the doubles are shared between the transactional and plain paths and a
   * test can arrange either one the same way. */
  const transactionManager = () => ({
    getRepository: jest.fn((entity: unknown) =>
      entity === Listing ? listings : offers,
    ),
    save: jest.fn((_entity: unknown, value: object) => Promise.resolve(value)),
    withRepository: jest.fn(() => listings),
  });

  /** The listing the offer is about, answered for both the `ref` load and the
   * locking read inside the transaction. */
  const listingExists = (listing: Listing) =>
    listings.findOne.mockResolvedValue(listing);

  const memberSlugResolves = (slug: string, userId: string) =>
    profiles.createQueryBuilder.mockReturnValue(
      profileQueryBuilder([{ slug, userId }]),
    );

  beforeEach(async () => {
    offers = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: object) => value),
      save: jest.fn((value: object) =>
        Promise.resolve({ id: 'offer-1', ...value }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    listings = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((value: object) => Promise.resolve(value)),
    };
    profiles = {
      // `MemberLookup.byUserIds`, which every DTO mapping runs through. An
      // empty result renders both member refs as null, which the DTO allows.
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => profileQueryBuilder([])),
    };
    ownership = {
      transferOwnership: jest.fn().mockResolvedValue(transferResult()),
      emitTransferChanges: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (manager: EntityManager) => Promise<unknown>) =>
          work(transactionManager() as unknown as EntityManager),
      ),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingOwnerOffersService,
        { provide: getRepositoryToken(ListingOwnerOffer), useValue: offers },
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: ListingOwnershipService, useValue: ownership },
        { provide: NotificationsService, useValue: notifications },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(ListingOwnerOffersService);
  });

  describe('offer', () => {
    it('rejects an offer on a listing that already has an owner', async () => {
      // Taking a business from its holder goes through claims and disputes,
      // both of which are reviewed and leave a trail. This route refuses
      // outright.
      listingExists(listingFixture({ ownerId: 'someone' }));
      memberSlugResolves(OFFEREE_SLUG, OFFEREE_ID);

      await expect(
        service.offer(LISTING_REF, ADMIN_ID, { memberSlug: OFFEREE_SLUG }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(offers.save).not.toHaveBeenCalled();
    });

    it('rejects a member slug that resolves to no active member', async () => {
      // The slug lookup inner-joins on an active user, so a suspended or
      // waitlisted member comes back empty and reads as no member at all.
      listingExists(listingFixture());
      profiles.createQueryBuilder.mockReturnValue(profileQueryBuilder([]));

      await expect(
        service.offer(LISTING_REF, ADMIN_ID, { memberSlug: OFFEREE_SLUG }),
      ).rejects.toThrow(new NotFoundException('Member not found'));
      expect(offers.save).not.toHaveBeenCalled();
    });

    it('reuses a terminal row when re-offering to the same member', async () => {
      // One row per (listing, member) pair, reused across every offer it ever
      // sees. Each field describing the offer that ended is rewritten.
      const declined = offerFixture({
        status: ListingOwnerOfferStatus.Declined,
        offeredAt: new Date('2026-01-01T00:00:00.000Z'),
        respondedAt: new Date('2026-01-02T00:00:00.000Z'),
        offeredByUserId: 'a-previous-admin',
      });
      listingExists(listingFixture());
      memberSlugResolves(OFFEREE_SLUG, OFFEREE_ID);
      offers.findOne.mockResolvedValue(declined);

      await service.offer(LISTING_REF, ADMIN_ID, {
        memberSlug: OFFEREE_SLUG,
        note: 'We wrote this page for your café.',
      });

      // The declined row itself is what was handed to `save`, so asserting on
      // the fixture object asserts the rewrite in place.
      expect(offers.create).not.toHaveBeenCalled();
      expect(offers.save).toHaveBeenCalledTimes(1);
      expect(offers.save).toHaveBeenCalledWith(declined);
      expect(declined.status).toBe(ListingOwnerOfferStatus.Offered);
      expect(declined.respondedAt).toBeNull();
      expect(declined.offeredByUserId).toBe(ADMIN_ID);
      expect(declined.note).toBe('We wrote this page for your café.');
      expect(declined.offeredAt.getTime()).toBeGreaterThan(
        new Date('2026-01-01T00:00:00.000Z').getTime(),
      );
    });

    it('converts the open-offer unique violation into a conflict', async () => {
      // Two people cannot both be told they are being given the business. The
      // partial unique index enforces it, and its violation comes back as a
      // 409 telling staff to revoke the open offer first.
      listingExists(listingFixture());
      memberSlugResolves('other-member', OTHER_MEMBER_ID);
      offers.findOne.mockResolvedValue(null);
      offers.save.mockRejectedValue(openOfferUniqueViolation());

      await expect(
        service.offer(LISTING_REF, ADMIN_ID, { memberSlug: 'other-member' }),
      ).rejects.toThrow(
        new ConflictException(
          'This listing already has an open offer. Revoke it before offering to somebody else.',
        ),
      );
    });

    it('lets a unique violation on a different index propagate', async () => {
      // The catch is scoped to the open-offer index by name. A violation on
      // any other constraint is a real bug and has to reach the caller as
      // itself, so drop the second argument to `isUniqueViolation` and this
      // fails.
      listingExists(listingFixture());
      memberSlugResolves(OFFEREE_SLUG, OFFEREE_ID);
      const unrelatedViolation = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          driverError: {
            code: '23505',
            constraint: 'UQ_listing_owner_offers_pair',
          },
        },
      );
      offers.save.mockRejectedValue(unrelatedViolation);

      await expect(
        service.offer(LISTING_REF, ADMIN_ID, { memberSlug: OFFEREE_SLUG }),
      ).rejects.toBe(unrelatedViolation);
    });

    it('refuses an offer when the locked listing row shows an owner', async () => {
      // The outer guard read a row nothing was holding. An approved claim can
      // land between that read and the lock, so the re-read under the
      // pessimistic lock is the one that decides.
      listings.findOne
        .mockResolvedValueOnce(listingFixture())
        .mockResolvedValue(listingFixture({ ownerId: 'bruno' }));
      memberSlugResolves(OFFEREE_SLUG, OFFEREE_ID);

      await expect(
        service.offer(LISTING_REF, ADMIN_ID, { memberSlug: OFFEREE_SLUG }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(offers.save).not.toHaveBeenCalled();
    });

    it('notifies the offered member once the offer has committed', async () => {
      listingExists(listingFixture());
      memberSlugResolves(OFFEREE_SLUG, OFFEREE_ID);

      await service.offer(LISTING_REF, ADMIN_ID, {
        memberSlug: OFFEREE_SLUG,
      });

      expect(notifications.create).toHaveBeenCalledWith(
        OFFEREE_ID,
        NotificationType.ListingOwnerOffer,
        expect.objectContaining({
          actorId: ADMIN_ID,
          source: 'listing',
          listingSlug: 'lux-cafe',
          listingName: 'Lux Café',
        }),
        ADMIN_ID,
      );
    });
  });

  describe('revoke', () => {
    it('404s when the listing has no open offer', async () => {
      listingExists(listingFixture());
      offers.findOne.mockResolvedValue(null);

      await expect(service.revoke(LISTING_REF, ADMIN_ID)).rejects.toThrow(
        new NotFoundException('No open offer on this listing'),
      );
      expect(offers.update).not.toHaveBeenCalled();
    });

    it('withdraws the open offer without telling the member', async () => {
      // A revoked offer the member never answered is not news, so no
      // notification is sent.
      listingExists(listingFixture());
      offers.findOne.mockResolvedValue(offerFixture());

      const dto = await service.revoke(LISTING_REF, ADMIN_ID);

      expect(offers.update).toHaveBeenCalledWith(
        { id: 'offer-1', status: ListingOwnerOfferStatus.Offered },
        expect.objectContaining({ status: ListingOwnerOfferStatus.Revoked }),
      );
      expect(dto.status).toBe(ListingOwnerOfferStatus.Revoked);
      expect(dto.respondedAt).not.toBeNull();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  /**
   * The delegation panel's cold-open read. Its two states are the whole
   * contract: a listing carrying an open offer, and the far more common one
   * carrying none. The second answers `null` with a 200, because a listing
   * without an open offer is the ordinary state of the directory and a 404
   * there would be indistinguishable from a `ref` that does not exist.
   */
  describe('findOpenForListing', () => {
    it('returns the listing open offer, in the same shape the write paths return', async () => {
      listingExists(listingFixture());
      offers.findOne.mockResolvedValue(offerFixture());

      const dto = await service.findOpenForListing(LISTING_REF);

      expect(dto).toEqual(
        expect.objectContaining({
          id: 'offer-1',
          status: ListingOwnerOfferStatus.Offered,
        }),
      );
      // Scoped to the one status the partial unique index permits one of, so
      // an answered offer on the same listing stays out of the panel.
      expect(offers.findOne).toHaveBeenCalledWith({
        where: {
          listingId: LISTING_ID,
          status: ListingOwnerOfferStatus.Offered,
        },
      });
    });

    it('answers null for a listing with no open offer', async () => {
      listingExists(listingFixture());
      offers.findOne.mockResolvedValue(null);

      await expect(service.findOpenForListing(LISTING_REF)).resolves.toBeNull();
    });

    it('404s for a ref that matches no listing', async () => {
      listings.findOne.mockResolvedValue(null);

      await expect(
        service.findOpenForListing('QPL-2026-9999'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(offers.findOne).not.toHaveBeenCalled();
    });
  });

  describe('listForMember', () => {
    it('asks for the member open offers newest first and maps each to its listing', async () => {
      const older = offerFixture({
        id: 'offer-older',
        offeredAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      const newer = offerFixture({
        id: 'offer-newer',
        listingId: 'listing-2',
        offeredAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      // The repository applies the ordering; the double returns the order the
      // service asked for so the mapping is what this asserts.
      offers.find.mockResolvedValue([newer, older]);
      listings.find.mockResolvedValue([
        listingFixture(),
        listingFixture({ id: 'listing-2', ref: 'QPL-2026-0002', slug: 'orla' }),
      ]);

      const dtos = await service.listForMember(OFFEREE_ID);

      expect(offers.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            offereeId: OFFEREE_ID,
            status: ListingOwnerOfferStatus.Offered,
          },
          order: { offeredAt: 'DESC' },
        }),
      );
      expect(dtos.map((dto) => dto.id)).toEqual(['offer-newer', 'offer-older']);
      // `noUncheckedIndexedAccess` makes an index read `T | undefined`, so the
      // two rows are narrowed by a real check before they are asserted on.
      const [newerDto, olderDto] = dtos;
      if (!newerDto || !olderDto) {
        throw new Error(
          'listForMember dropped one of the two offers it was given',
        );
      }
      expect(newerDto.listingSlug).toBe('orla');
      expect(olderDto.listingRef).toBe(LISTING_REF);
      // One batched listing lookup for the whole page.
      expect(listings.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('respond', () => {
    it('emits the transfer changes once, after the accept commits', async () => {
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());
      let wasEmittedBeforeCommit = false;
      dataSource.transaction.mockImplementation(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          const value = await work(
            transactionManager() as unknown as EntityManager,
          );
          wasEmittedBeforeCommit =
            ownership.emitTransferChanges.mock.calls.length > 0;
          return value;
        },
      );

      await service.respond('offer-1', OFFEREE_ID, true);

      expect(wasEmittedBeforeCommit).toBe(false);
      expect(ownership.emitTransferChanges).toHaveBeenCalledTimes(1);
      expect(ownership.emitTransferChanges).toHaveBeenCalledWith(
        transferResult(),
      );
    });

    it('emits nothing when the accept commit fails', async () => {
      // The callback runs to the end, transfer included, and then the commit
      // throws, so this proves no emission rides inside the transaction.
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());
      dataSource.transaction.mockImplementation(
        async (work: (manager: EntityManager) => Promise<unknown>) => {
          await work(transactionManager() as unknown as EntityManager);
          throw new Error('commit failed');
        },
      );

      await expect(
        service.respond('offer-1', OFFEREE_ID, true),
      ).rejects.toThrow('commit failed');
      expect(ownership.transferOwnership).toHaveBeenCalledTimes(1);
      expect(ownership.emitTransferChanges).not.toHaveBeenCalled();
    });

    it('emits nothing on a decline', async () => {
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());

      await service.respond('offer-1', OFFEREE_ID, false);

      expect(ownership.emitTransferChanges).not.toHaveBeenCalled();
    });

    it('404s when the offer is addressed to somebody else', async () => {
      // Scoped by `{ id, offereeId }`, so an offer id is no oracle for which
      // listings staff are trying to give away.
      offers.findOne.mockResolvedValue(null);

      await expect(
        service.respond('offer-1', OTHER_MEMBER_ID, true),
      ).rejects.toThrow(new NotFoundException('Offer not found'));
      expect(offers.findOne).toHaveBeenCalledWith({
        where: { id: 'offer-1', offereeId: OTHER_MEMBER_ID },
      });
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
    });

    it('rejects a second response to an already answered offer', async () => {
      // The row still reads `offered` because the racing tab loaded it first;
      // the conditional UPDATE is what catches up, reporting affected 0.
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());
      offers.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.respond('offer-1', OFFEREE_ID, true),
      ).rejects.toThrow(
        new ConflictException('This offer has already been answered'),
      );
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
    });

    it('refuses an accept once somebody else has taken the listing', async () => {
      // No race is needed for this one. Staff offer an unowned listing to
      // Ana. Bruno's claim is approved days later and the shared transfer
      // hands him the listing, which leaves Ana's row sitting at `offered`
      // because nothing closes an offer when a listing changes hands by
      // another route. Ana then accepts. Without the re-check inside the
      // transaction that accept takes the listing off Bruno and wipes the
      // contact details he filled in.
      const claimedListing = listingFixture({ ownerId: 'bruno' });
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(claimedListing);

      await expect(
        service.respond('offer-1', OFFEREE_ID, true),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
      expect(claimedListing.ownerId).toBe('bruno');
      expect(claimedListing.affirmingBaselineAcceptedAt).toBeNull();
    });

    it('still lets the member decline a listing somebody else has taken', async () => {
      // The guard above is accept-only. Declining a stale offer takes nothing
      // from the member now holding the listing, and it clears the row off
      // the offeree's list, so it stays allowed.
      const claimedListing = listingFixture({ ownerId: 'bruno' });
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(claimedListing);

      const declined = await service.respond('offer-1', OFFEREE_ID, false);

      expect(declined.status).toBe(ListingOwnerOfferStatus.Declined);
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
      expect(claimedListing.ownerId).toBe('bruno');
    });

    it('stamps the affirming baseline on accept', async () => {
      const listing = listingFixture();
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listing);

      await service.respond('offer-1', OFFEREE_ID, true);

      expect(listing.affirmingBaselineAcceptedAt).toBeInstanceOf(Date);
      // Stamped BEFORE the transfer, because the transfer is what saves the
      // listing row. The helper is handed that same object, so the stamp goes
      // to the database with the reassignment.
      expect(ownership.transferOwnership).toHaveBeenCalledWith(
        expect.anything(),
        listing,
        OFFEREE_ID,
        OFFEREE_ID,
        'Ownership accepted from a staff offer.',
        expect.any(Date),
      );
    });

    it('calls transferOwnership once on accept and never on decline', async () => {
      // The shared helper is the only route into `listings.owner_id`.
      offers.findOne.mockImplementation(() =>
        Promise.resolve(offerFixture({ id: 'offer-accept' })),
      );
      listingExists(listingFixture());

      const accepted = await service.respond('offer-accept', OFFEREE_ID, true);

      expect(accepted.status).toBe(ListingOwnerOfferStatus.Accepted);
      expect(ownership.transferOwnership).toHaveBeenCalledTimes(1);
      // The member accepting is both the new owner and the actor, so the two
      // id arguments are the same person.
      expect(ownership.transferOwnership).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: LISTING_ID }),
        OFFEREE_ID,
        OFFEREE_ID,
        'Ownership accepted from a staff offer.',
        expect.any(Date),
      );

      ownership.transferOwnership.mockClear();
      const declinedListing = listingFixture();
      offers.findOne.mockImplementation(() =>
        Promise.resolve(offerFixture({ id: 'offer-decline' })),
      );
      listingExists(declinedListing);

      const declined = await service.respond(
        'offer-decline',
        OFFEREE_ID,
        false,
      );

      expect(declined.status).toBe(ListingOwnerOfferStatus.Declined);
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
      // The stamp is written by this service directly, so its absence is a
      // real assertion about the decline branch.
      expect(declinedListing.affirmingBaselineAcceptedAt).toBeNull();
    });

    it('lets exactly one of two concurrent accepts win', async () => {
      // Both tabs read the row while it is still `offered`, so both reach the
      // conditional UPDATE. The database settles it: one reports affected 1,
      // the loser reports 0 and raises 409 before it can reach the transfer,
      // so the ownership write only ever happens once.
      let updateCallCount = 0;
      offers.findOne.mockImplementation(() => Promise.resolve(offerFixture()));
      listings.findOne.mockImplementation(() =>
        Promise.resolve(listingFixture()),
      );
      offers.update.mockImplementation(() => {
        updateCallCount += 1;
        return Promise.resolve({ affected: updateCallCount === 1 ? 1 : 0 });
      });

      const outcomes = await Promise.allSettled([
        service.respond('offer-1', OFFEREE_ID, true),
        service.respond('offer-1', OFFEREE_ID, true),
      ]);

      const fulfilled = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome) => outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(ownership.transferOwnership).toHaveBeenCalledTimes(1);
    });

    /**
     * THE ORDER OF THESE TWO WRITES IS THE GUARANTEE, and it is asserted here
     * because here is where it is decided.
     *
     * `ListingOwnershipService.transferOwnership` sweeps every owner-offer row
     * still sitting at `offered` for the listing and revokes it. That sweep
     * exists because a claim approval otherwise leaves a dead open offer
     * holding the single slot the partial unique index
     * `UQ_listing_owner_offers_open` permits, and because such a row becomes
     * acceptable again if `owner_id` later returns to NULL through owner
     * erasure.
     *
     * The one thing that keeps the sweep off the offer being accepted is that
     * `respond` flips its own row to `accepted` BEFORE it calls the transfer.
     * Reverse the two statements and the member's accept revokes itself: the
     * listing changes hands and the offer that caused it reads as withdrawn.
     * Asserting that both were called would pass either way, so this compares
     * `mock.invocationCallOrder`, which is the only thing that fails when the
     * order changes.
     */
    it('flips its own offer row out of offered before it calls transferOwnership', async () => {
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());

      await service.respond('offer-1', OFFEREE_ID, true);

      const [flipCriteria, flipValues] = offers.update.mock.calls[0] as [
        { id: string; status: ListingOwnerOfferStatus },
        { status: ListingOwnerOfferStatus },
      ];
      // The flip is the conditional UPDATE off `offered`, which is exactly
      // the status the sweep's predicate looks for.
      expect(flipCriteria.status).toBe(ListingOwnerOfferStatus.Offered);
      expect(flipValues.status).toBe(ListingOwnerOfferStatus.Accepted);

      const [flipOrder] = offers.update.mock.invocationCallOrder;
      const [transferOrder] =
        ownership.transferOwnership.mock.invocationCallOrder;
      // `noUncheckedIndexedAccess` types both of these as possibly
      // undefined, and undefined here has a meaning worth failing on in its
      // own right: one of the two calls never happened at all. A version
      // that skipped `transferOwnership` entirely would slip past a bare
      // comparison, so it is caught here before the ordering is compared.
      if (flipOrder === undefined || transferOrder === undefined) {
        throw new Error(
          'Expected both the offer flip and the ownership transfer to have been called',
        );
      }
      expect(flipOrder).toBeLessThan(transferOrder);
    });

    // The decline branch never reaches the transfer, so the sweep never runs
    // for it. The row still leaves `offered`, which is what frees the open
    // slot for a later offer on the same listing.
    it('flips its own offer row out of offered on a decline too', async () => {
      offers.findOne.mockResolvedValue(offerFixture());
      listingExists(listingFixture());

      await service.respond('offer-1', OFFEREE_ID, false);

      const [flipCriteria, flipValues] = offers.update.mock.calls[0] as [
        { id: string; status: ListingOwnerOfferStatus },
        { status: ListingOwnerOfferStatus },
      ];
      expect(flipCriteria.status).toBe(ListingOwnerOfferStatus.Offered);
      expect(flipValues.status).toBe(ListingOwnerOfferStatus.Declined);
      expect(ownership.transferOwnership).not.toHaveBeenCalled();
    });
  });
});
