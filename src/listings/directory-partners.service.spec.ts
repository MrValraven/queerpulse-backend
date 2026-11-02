import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  CLOSE_POSITION_GAP_SQL,
  DEFER_POSITION_SQL,
  DirectoryPartnersService,
  LOCK_PARTNER_PICKS_SQL,
  REORDER_PARTNER_PICKS_SQL,
} from './directory-partners.service';
import { DirectoryService } from './directory.service';
import { DirectoryPartnerPick } from './entities/directory-partner-pick.entity';
import {
  type Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';

const ADMIN_ID = 'd7200000-0000-4000-8000-000000000001';
const FIRST_LISTING_ID = 'd7200000-0000-4000-8000-000000000011';
const SECOND_LISTING_ID = 'd7200000-0000-4000-8000-000000000012';
const FIRST_PICK_ID = 'd7200000-0000-4000-8000-000000000021';
const SECOND_PICK_ID = 'd7200000-0000-4000-8000-000000000022';
const THIRD_PICK_ID = 'd7200000-0000-4000-8000-000000000023';
const FOURTH_PICK_ID = 'd7200000-0000-4000-8000-000000000024';

async function reasonOf(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { reason?: string })
      .reason;
  }
}

/** The global call order of one call of a mock. Throws when that call never
 *  happened, so an order assertion can not pass on a missing call. */
function callOrderOf(mockFunction: jest.Mock, callIndex = 0): number {
  const callOrder = mockFunction.mock.invocationCallOrder[callIndex];
  if (callOrder === undefined) {
    throw new Error(`Call ${callIndex} of the mock never happened`);
  }
  return callOrder;
}

function buildListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: FIRST_LISTING_ID,
    ref: 'QPL-2026-0007',
    slug: 'casa-t',
    name: 'Casa T',
    cats: ['space', 'food'],
    hood: 'Anjos',
    status: ListingStatus.Live,
    operatingState: ListingOperatingState.Open,
    isHiddenByOwner: false,
    coverPhoto: null,
    photoGallery: [],
    ...overrides,
  } as unknown as Listing;
}

function buildPick(
  id: string,
  position: number,
  listing: Listing,
  note: string | null = null,
): DirectoryPartnerPick {
  return {
    id,
    listingId: listing.id,
    listing,
    note,
    position,
  } as DirectoryPartnerPick;
}

describe('DirectoryPartnersService', () => {
  let manager: {
    query: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    maximum: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let directoryService: {
    searchListedListings: jest.Mock;
    moderatedListingSlugs: jest.Mock;
  };
  let service: DirectoryPartnersService;

  beforeEach(() => {
    manager = {
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      maximum: jest.fn().mockResolvedValue(null),
      create: jest.fn((_entity: unknown, row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ ...row, id: FIRST_PICK_ID }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    directoryService = {
      searchListedListings: jest.fn().mockResolvedValue([]),
      moderatedListingSlugs: jest.fn().mockResolvedValue(new Set()),
    };
    service = new DirectoryPartnersService(
      dataSource as unknown as DataSource,
      directoryService as unknown as DirectoryService,
    );
  });

  describe('listPartners', () => {
    it('lists every pick in position order with its listing and public state', async () => {
      const firstListing = buildListing();
      const secondListing = buildListing({
        id: SECOND_LISTING_ID,
        slug: 'bar-pride',
        name: 'Bar Pride',
      });
      manager.find.mockResolvedValue([
        buildPick(FIRST_PICK_ID, 1, firstListing, 'Members get 10% off'),
        buildPick(SECOND_PICK_ID, 2, secondListing),
      ]);
      directoryService.moderatedListingSlugs.mockResolvedValue(
        new Set(['bar-pride']),
      );

      const partners = await service.listPartners();

      expect(manager.find).toHaveBeenCalledWith(DirectoryPartnerPick, {
        relations: { listing: true },
        order: { position: 'ASC' },
      });
      expect(partners.map((partner) => partner.publicState)).toEqual([
        'showing',
        'moderated',
      ]);
      expect(partners.map((partner) => partner.id)).toEqual([
        FIRST_PICK_ID,
        SECOND_PICK_ID,
      ]);
      expect(partners[0]).toEqual(
        expect.objectContaining({
          listingId: FIRST_LISTING_ID,
          listingRef: 'QPL-2026-0007',
          note: 'Members get 10% off',
          position: 1,
        }),
      );
      expect(directoryService.moderatedListingSlugs).toHaveBeenCalledTimes(1);
      expect(directoryService.moderatedListingSlugs).toHaveBeenCalledWith([
        'casa-t',
        'bar-pride',
      ]);
    });

    it('shows the reason a closed, paused, in-review or 18+ partner is not showing', async () => {
      manager.find.mockResolvedValue([
        buildPick(
          FIRST_PICK_ID,
          1,
          buildListing({
            slug: 'closed-bar',
            operatingState: ListingOperatingState.PermanentlyClosed,
          }),
        ),
        buildPick(
          SECOND_PICK_ID,
          2,
          buildListing({ slug: 'paused-cafe', isHiddenByOwner: true }),
        ),
        buildPick(
          THIRD_PICK_ID,
          3,
          buildListing({ slug: 'new-shop', status: ListingStatus.Review }),
        ),
        buildPick(
          FOURTH_PICK_ID,
          4,
          buildListing({ slug: 'late-club', cats: ['intimacy'] }),
        ),
      ]);

      const partners = await service.listPartners();

      expect(partners.map((partner) => partner.publicState)).toEqual([
        'closed_for_good',
        'hidden_by_owner',
        'not_live',
        'adult_only',
      ]);
    });
  });

  describe('searchListings', () => {
    it('searches live, publicly listed listings by folded name, 20 at most, and marks the ones already picked', async () => {
      directoryService.searchListedListings.mockResolvedValue([
        {
          id: FIRST_LISTING_ID,
          slug: 'casa-t',
          name: 'Casa T',
          cats: ['space'],
          hood: 'Anjos',
        },
        {
          id: SECOND_LISTING_ID,
          slug: 'casa-rosa',
          name: 'Casa Rosa',
          cats: ['food'],
          hood: 'Graça',
        },
      ]);
      manager.find.mockResolvedValue([{ listingId: SECOND_LISTING_ID }]);

      const results = await service.searchListings('  casa  ');

      expect(directoryService.searchListedListings).toHaveBeenCalledWith(
        'casa',
        20,
      );
      expect(manager.find).toHaveBeenCalledWith(DirectoryPartnerPick, {
        select: { listingId: true },
      });
      expect(results.map((result) => result.listingId)).toEqual([
        FIRST_LISTING_ID,
        SECOND_LISTING_ID,
      ]);
      expect(results.map((result) => result.isPartner)).toEqual([false, true]);
    });

    it('answers an empty list for a blank query without searching', async () => {
      expect(await service.searchListings('   ')).toEqual([]);
      expect(await service.searchListings(undefined)).toEqual([]);
      expect(directoryService.searchListedListings).not.toHaveBeenCalled();
    });

    it('cuts a query longer than 80 characters to its first 80', async () => {
      await service.searchListings('a'.repeat(120));

      expect(directoryService.searchListedListings).toHaveBeenCalledWith(
        'a'.repeat(80),
        20,
      );
    });
  });

  describe('addPartner', () => {
    beforeEach(() => {
      manager.findOne.mockResolvedValue(buildListing());
    });

    it('appends at the end under a table lock, with the trimmed note and the admin', async () => {
      manager.count.mockResolvedValue(3);
      manager.maximum.mockResolvedValue(3);
      const listing = buildListing();
      manager.find.mockResolvedValue([
        buildPick(FIRST_PICK_ID, 4, listing, 'Members get 10% off'),
      ]);

      const partners = await service.addPartner(ADMIN_ID, {
        listingId: FIRST_LISTING_ID,
        note: '  Members get 10% off  ',
      });

      expect(manager.query.mock.calls[0]).toEqual([LOCK_PARTNER_PICKS_SQL]);
      expect(LOCK_PARTNER_PICKS_SQL).toContain('"directory_partner_picks"');
      expect(LOCK_PARTNER_PICKS_SQL).toContain('SHARE ROW EXCLUSIVE');
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          where: { id: FIRST_LISTING_ID },
          lock: { mode: 'pessimistic_read' },
        }),
      );
      expect(manager.maximum).toHaveBeenCalledWith(
        DirectoryPartnerPick,
        'position',
      );
      expect(manager.create).toHaveBeenCalledWith(DirectoryPartnerPick, {
        listingId: FIRST_LISTING_ID,
        note: 'Members get 10% off',
        position: 4,
        createdById: ADMIN_ID,
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(partners).toEqual([
        expect.objectContaining({
          id: FIRST_PICK_ID,
          listingId: FIRST_LISTING_ID,
          note: 'Members get 10% off',
          position: 4,
          publicState: 'showing',
        }),
      ]);
    });

    it('appends after the highest position when a deleted listing left a gap', async () => {
      manager.count.mockResolvedValue(2);
      manager.maximum.mockResolvedValue(3);

      await service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID });

      expect(manager.create).toHaveBeenCalledWith(
        DirectoryPartnerPick,
        expect.objectContaining({ position: 4 }),
      );
    });

    it('starts at position 1 on an empty list', async () => {
      await service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID });

      expect(manager.create).toHaveBeenCalledWith(
        DirectoryPartnerPick,
        expect.objectContaining({ position: 1 }),
      );
    });

    it('refuses a note longer than 140 characters before any read', async () => {
      expect(
        await reasonOf(
          service.addPartner(ADMIN_ID, {
            listingId: FIRST_LISTING_ID,
            note: 'a'.repeat(141),
          }),
        ),
      ).toBe('note_too_long');
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('answers listing_not_found for an unknown or malformed listing id', async () => {
      manager.findOne.mockResolvedValue(null);
      manager.exists.mockResolvedValue(true);
      expect(
        await reasonOf(
          service.addPartner(ADMIN_ID, { listingId: SECOND_LISTING_ID }),
        ),
      ).toBe('listing_not_found');
      expect(manager.findOne).toHaveBeenCalledTimes(1);
      expect(manager.exists).not.toHaveBeenCalled();

      manager.findOne.mockClear();
      expect(
        await reasonOf(service.addPartner(ADMIN_ID, { listingId: 'nope' })),
      ).toBe('listing_not_found');
      expect(manager.findOne).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers already_partner before checking visibility', async () => {
      manager.findOne.mockResolvedValue(
        buildListing({ status: ListingStatus.Review }),
      );
      manager.exists.mockResolvedValue(true);

      expect(
        await reasonOf(
          service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID }),
        ),
      ).toBe('already_partner');
      expect(manager.exists).toHaveBeenCalledWith(DirectoryPartnerPick, {
        where: { listingId: FIRST_LISTING_ID },
      });
      expect(directoryService.moderatedListingSlugs).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it.each<[string, string, Partial<Listing>, boolean]>([
      [
        'an in-review listing',
        'listing_not_live',
        { status: ListingStatus.Review },
        false,
      ],
      [
        'a listing closed for good',
        'listing_not_live',
        { operatingState: ListingOperatingState.PermanentlyClosed },
        false,
      ],
      [
        'an owner-hidden listing',
        'listing_not_live',
        { isHiddenByOwner: true },
        false,
      ],
      ['a moderated listing', 'listing_not_live', {}, true],
      ['an 18+ listing', 'listing_adult_only', { cats: ['intimacy'] }, false],
    ])(
      'refuses %s with %s',
      async (_label, expectedReason, overrides, isModerated) => {
        manager.findOne.mockResolvedValue(buildListing(overrides));
        directoryService.moderatedListingSlugs.mockResolvedValue(
          new Set(isModerated ? ['casa-t'] : []),
        );

        expect(
          await reasonOf(
            service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID }),
          ),
        ).toBe(expectedReason);
        expect(directoryService.moderatedListingSlugs).toHaveBeenCalledWith([
          'casa-t',
        ]);
        expect(manager.save).not.toHaveBeenCalled();
      },
    );

    it('refuses a thirteenth partner with partner_limit_reached', async () => {
      manager.count.mockResolvedValue(12);

      expect(
        await reasonOf(
          service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID }),
        ),
      ).toBe('partner_limit_reached');
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers listing_not_live before partner_limit_reached on a full list', async () => {
      manager.count.mockResolvedValue(12);
      manager.findOne.mockResolvedValue(
        buildListing({ status: ListingStatus.Review }),
      );

      expect(
        await reasonOf(
          service.addPartner(ADMIN_ID, { listingId: FIRST_LISTING_ID }),
        ),
      ).toBe('listing_not_live');
      expect(manager.count).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('updateNote', () => {
    it('stores the trimmed note, or null for a blank one, and returns the list', async () => {
      const listing = buildListing();
      manager.find.mockResolvedValue([
        buildPick(FIRST_PICK_ID, 1, listing, 'Members get 10% off'),
      ]);

      const partners = await service.updateNote(FIRST_PICK_ID, {
        note: '  Members get 10% off ',
      });
      await service.updateNote(FIRST_PICK_ID, { note: '  ' });

      expect(manager.update).toHaveBeenNthCalledWith(
        1,
        DirectoryPartnerPick,
        { id: FIRST_PICK_ID },
        { note: 'Members get 10% off' },
      );
      expect(manager.update).toHaveBeenNthCalledWith(
        2,
        DirectoryPartnerPick,
        { id: FIRST_PICK_ID },
        { note: null },
      );
      expect(partners).toEqual([
        expect.objectContaining({
          id: FIRST_PICK_ID,
          note: 'Members get 10% off',
        }),
      ]);
    });

    it('answers partner_not_found for an unknown or malformed pick id', async () => {
      manager.update.mockResolvedValue({ affected: 0 });
      expect(
        await reasonOf(service.updateNote(SECOND_PICK_ID, { note: 'Hi' })),
      ).toBe('partner_not_found');
      expect(manager.update).toHaveBeenCalledWith(
        DirectoryPartnerPick,
        { id: SECOND_PICK_ID },
        { note: 'Hi' },
      );
      expect(manager.find).not.toHaveBeenCalled();

      manager.update.mockClear();
      expect(await reasonOf(service.updateNote('nope', { note: 'Hi' }))).toBe(
        'partner_not_found',
      );
      expect(
        await reasonOf(service.updateNote('nope', { note: 'a'.repeat(141) })),
      ).toBe('partner_not_found');
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('refuses a note longer than 140 characters before the pick is looked up', async () => {
      manager.update.mockResolvedValue({ affected: 0 });
      expect(
        await reasonOf(
          service.updateNote(FIRST_PICK_ID, { note: 'a'.repeat(141) }),
        ),
      ).toBe('note_too_long');
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('reorderPartners', () => {
    beforeEach(() => {
      manager.find.mockResolvedValueOnce([
        { id: FIRST_PICK_ID },
        { id: SECOND_PICK_ID },
      ]);
    });

    it('locks the table, defers the position constraint, then reads the current picks', async () => {
      await service.reorderPartners([FIRST_PICK_ID, SECOND_PICK_ID]);

      expect(manager.query.mock.calls.slice(0, 2)).toEqual([
        [LOCK_PARTNER_PICKS_SQL],
        [DEFER_POSITION_SQL],
      ]);
      expect(DEFER_POSITION_SQL).toContain(
        'SET CONSTRAINTS "UQ_directory_partner_picks_position" DEFERRED',
      );
      expect(LOCK_PARTNER_PICKS_SQL).toContain('SHARE ROW EXCLUSIVE');
      expect(callOrderOf(manager.query, 1)).toBeLessThan(
        callOrderOf(manager.find),
      );
      expect(manager.find).toHaveBeenNthCalledWith(1, DirectoryPartnerPick, {
        select: { id: true },
      });
    });

    it('writes positions 1..n in one statement in the requested order', async () => {
      await service.reorderPartners([
        SECOND_PICK_ID.toUpperCase(),
        FIRST_PICK_ID,
      ]);

      const reorderCalls = manager.query.mock.calls.filter(
        ([sql]) => sql === REORDER_PARTNER_PICKS_SQL,
      );
      expect(reorderCalls).toEqual([
        [
          REORDER_PARTNER_PICKS_SQL,
          [
            [SECOND_PICK_ID, FIRST_PICK_ID],
            [1, 2],
          ],
        ],
      ]);
    });

    it('answers order_mismatch for a stale list from another tab', async () => {
      manager.find.mockReset();
      manager.find.mockResolvedValueOnce([{ id: FIRST_PICK_ID }]);

      expect(
        await reasonOf(
          service.reorderPartners([FIRST_PICK_ID, SECOND_PICK_ID]),
        ),
      ).toBe('order_mismatch');
      expect(manager.query).not.toHaveBeenCalledWith(
        REORDER_PARTNER_PICKS_SQL,
        expect.anything(),
      );
    });

    it('answers order_mismatch for a repeated or a malformed id', async () => {
      expect(
        await reasonOf(service.reorderPartners([FIRST_PICK_ID, FIRST_PICK_ID])),
      ).toBe('order_mismatch');

      manager.find.mockResolvedValueOnce([
        { id: FIRST_PICK_ID },
        { id: SECOND_PICK_ID },
      ]);
      expect(
        await reasonOf(service.reorderPartners([FIRST_PICK_ID, 'nope'])),
      ).toBe('order_mismatch');
      expect(manager.query).not.toHaveBeenCalledWith(
        REORDER_PARTNER_PICKS_SQL,
        expect.anything(),
      );
    });
  });

  describe('removePartner', () => {
    it('deletes the pick and closes the gap in one statement under the table lock', async () => {
      manager.findOne.mockResolvedValue({ id: SECOND_PICK_ID, position: 2 });

      await service.removePartner(SECOND_PICK_ID);

      expect(manager.query.mock.calls).toEqual([
        [LOCK_PARTNER_PICKS_SQL],
        [CLOSE_POSITION_GAP_SQL, [2]],
      ]);
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.findOne).toHaveBeenCalledWith(DirectoryPartnerPick, {
        where: { id: SECOND_PICK_ID },
        select: { id: true, position: true },
      });
      expect(manager.delete).toHaveBeenCalledWith(DirectoryPartnerPick, {
        id: SECOND_PICK_ID,
      });
      expect(callOrderOf(manager.delete)).toBeLessThan(
        callOrderOf(manager.query, 1),
      );
    });

    it('answers partner_not_found for an unknown or malformed pick id', async () => {
      expect(await reasonOf(service.removePartner(SECOND_PICK_ID))).toBe(
        'partner_not_found',
      );
      expect(manager.delete).not.toHaveBeenCalled();

      dataSource.transaction.mockClear();
      expect(await reasonOf(service.removePartner('nope'))).toBe(
        'partner_not_found',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
