import { ArrayContains, FindOneOptions, Not, Repository } from 'typeorm';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';
import { ADULT_LISTING_CATEGORY_SLUG } from './listing-categories';
import { ListingLookupService } from './listing-lookup.service';

// The venue predicate lives in the `where` handed to Postgres, so these tests
// pin that object: a mocked repository cannot evaluate it, and the real
// guarantee ("an online-only or 18+ listing never resolves") is the SQL it
// becomes. `DirectoryService.PUBLICLY_LISTED` already proves the same
// `Not(ArrayContains(...))` shape against the 18+ category.
describe('ListingLookupService', () => {
  let listings: {
    findOne: jest.Mock<Promise<unknown>, [FindOneOptions<Listing>]>;
  };
  let contentModeration: {
    statesForAnyType: jest.Mock<
      Promise<Map<string, ContentModerationState>>,
      [readonly string[], readonly string[]]
    >;
  };
  let service: ListingLookupService;

  const placeWithOnlineShop = {
    id: 'listing-shop',
    slug: 'corner-books',
    name: 'Corner Books',
    ownerId: 'owner-1',
    online: false,
    hasOnlineShop: true,
    cats: ['bookshop'],
  };

  const whereOfLastLookup = (): Record<string, unknown> => {
    const [options] = listings.findOne.mock.calls.at(-1)!;
    return options.where as Record<string, unknown>;
  };

  beforeEach(() => {
    listings = {
      findOne: jest
        .fn<Promise<unknown>, [FindOneOptions<Listing>]>()
        .mockResolvedValue(null),
    };
    contentModeration = {
      statesForAnyType: jest
        .fn<
          Promise<Map<string, ContentModerationState>>,
          [readonly string[], readonly string[]]
        >()
        .mockResolvedValue(new Map()),
    };
    service = new ListingLookupService(
      listings as unknown as Repository<Listing>,
      contentModeration as unknown as ContentModerationService,
    );
  });

  describe('findAttachable', () => {
    it('keeps the existing live, operating and shown checks', async () => {
      await service.findAttachable('listing-1');
      expect(whereOfLastLookup()).toMatchObject({
        id: 'listing-1',
        status: ListingStatus.Live,
        operatingState: Not(ListingOperatingState.PermanentlyClosed),
        isHiddenByOwner: false,
      });
    });

    it('refuses an 18+ listing in-query', async () => {
      await expect(service.findAttachable('listing-adult')).resolves.toBeNull();
      expect(whereOfLastLookup().cats).toEqual(
        Not(ArrayContains([ADULT_LISTING_CATEGORY_SLUG])),
      );
    });

    it('refuses an online-only listing in-query', async () => {
      await expect(
        service.findAttachable('listing-online'),
      ).resolves.toBeNull();
      expect(whereOfLastLookup().online).toBe(false);
    });

    it('refuses an out-and-about listing in-query', async () => {
      await expect(
        service.findAttachable('listing-mobile'),
      ).resolves.toBeNull();
      expect(whereOfLastLookup().mobile).toBe(false);
    });

    it('accepts a place that also sells online', async () => {
      listings.findOne.mockResolvedValue(placeWithOnlineShop);
      await expect(
        service.findAttachable(placeWithOnlineShop.id),
      ).resolves.toEqual({
        id: 'listing-shop',
        slug: 'corner-books',
        name: 'Corner Books',
        ownerId: 'owner-1',
      });
      // Selling online is no bar for a place: only `online` is constrained.
      expect(whereOfLastLookup()).not.toHaveProperty('hasOnlineShop');
    });
  });

  describe('findLinkable', () => {
    it('shares the venue predicate with findAttachable', async () => {
      await service.findLinkable('listing-1');
      expect(whereOfLastLookup()).toMatchObject({
        online: false,
        mobile: false,
        cats: Not(ArrayContains([ADULT_LISTING_CATEGORY_SLUG])),
      });
    });
  });

  describe('findLive', () => {
    it('still resolves an online-only or 18+ venue for display', async () => {
      await service.findLive('listing-1');
      const where = whereOfLastLookup();
      expect(where).toEqual({ id: 'listing-1', status: ListingStatus.Live });
    });

    // The pin and the address follow the listing's own public page (see
    // `VenueListingRef`).
    const pinnedVenue = {
      id: 'listing-pinned',
      slug: 'casa-lux',
      name: 'Casa Lux',
      online: false,
      isHiddenByOwner: false,
      operatingState: ListingOperatingState.Open,
      latitude: 38.7223,
      longitude: -9.1393,
      address: 'Rua da Rosa 12, Lisboa',
    };

    it('carries the pin and address of a venue whose public page shows them', async () => {
      listings.findOne.mockResolvedValue(pinnedVenue);
      await expect(service.findLive(pinnedVenue.id)).resolves.toEqual({
        slug: 'casa-lux',
        name: 'Casa Lux',
        latitude: 38.7223,
        longitude: -9.1393,
        address: 'Rua da Rosa 12, Lisboa',
      });
      expect(contentModeration.statesForAnyType).toHaveBeenCalledWith(
        ['business', 'listing'],
        ['casa-lux'],
      );
    });

    it('keeps the pin and address of a permanently closed venue, whose page stays up', async () => {
      listings.findOne.mockResolvedValue({
        ...pinnedVenue,
        operatingState: ListingOperatingState.PermanentlyClosed,
      });
      await expect(service.findLive(pinnedVenue.id)).resolves.toMatchObject({
        latitude: 38.7223,
        longitude: -9.1393,
        address: 'Rua da Rosa 12, Lisboa',
      });
    });

    it.each([
      ['paused by its owner', { isHiddenByOwner: true }, null],
      ['online-only', { online: true }, null],
      ['missing half its pin', { longitude: null }, 'Rua da Rosa 12, Lisboa'],
    ])(
      'keeps the name and drops the pin of a venue %s',
      async (_label, overrides, expectedAddress) => {
        listings.findOne.mockResolvedValue({ ...pinnedVenue, ...overrides });
        await expect(service.findLive(pinnedVenue.id)).resolves.toEqual({
          slug: 'casa-lux',
          name: 'Casa Lux',
          latitude: null,
          longitude: null,
          address: expectedAddress,
        });
      },
    );

    it.each([
      ['hidden', { hidden: true, removed: false }],
      ['removed', { hidden: false, removed: true }],
    ])(
      'drops the pin and address of a venue a moderator has %s',
      async (_label, moderationState) => {
        listings.findOne.mockResolvedValue(pinnedVenue);
        contentModeration.statesForAnyType.mockResolvedValue(
          new Map([['casa-lux', moderationState]]),
        );
        await expect(service.findLive(pinnedVenue.id)).resolves.toMatchObject({
          name: 'Casa Lux',
          latitude: null,
          longitude: null,
          address: null,
        });
      },
    );

    it('trims the address the public page prints', async () => {
      listings.findOne.mockResolvedValue({
        ...pinnedVenue,
        address: '  Rua da Rosa 12, Lisboa \n',
      });
      await expect(service.findLive(pinnedVenue.id)).resolves.toMatchObject({
        address: 'Rua da Rosa 12, Lisboa',
      });
    });

    it('carries the address of a venue that never placed a pin', async () => {
      listings.findOne.mockResolvedValue({
        ...pinnedVenue,
        latitude: null,
        longitude: null,
      });
      await expect(service.findLive(pinnedVenue.id)).resolves.toEqual({
        slug: 'casa-lux',
        name: 'Casa Lux',
        latitude: null,
        longitude: null,
        address: 'Rua da Rosa 12, Lisboa',
      });
      expect(contentModeration.statesForAnyType).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['empty', ''],
      ['only whitespace', '   '],
    ])(
      'keeps the pin and drops an address that is %s',
      async (_label, address) => {
        listings.findOne.mockResolvedValue({ ...pinnedVenue, address });
        await expect(service.findLive(pinnedVenue.id)).resolves.toEqual({
          slug: 'casa-lux',
          name: 'Casa Lux',
          latitude: 38.7223,
          longitude: -9.1393,
          address: null,
        });
      },
    );

    it.each([
      [
        'unpinned with a blank address',
        { latitude: null, longitude: null, address: '   ' },
      ],
      ['online-only', { online: true }],
    ])(
      'skips the moderation read for a venue %s, with nothing to withhold',
      async (_label, overrides) => {
        listings.findOne.mockResolvedValue({ ...pinnedVenue, ...overrides });
        await expect(service.findLive(pinnedVenue.id)).resolves.toEqual({
          slug: 'casa-lux',
          name: 'Casa Lux',
          latitude: null,
          longitude: null,
          address: null,
        });
        expect(contentModeration.statesForAnyType).not.toHaveBeenCalled();
      },
    );

    it('skips the moderation read for a venue its owner paused', async () => {
      listings.findOne.mockResolvedValue({
        ...pinnedVenue,
        isHiddenByOwner: true,
      });
      await service.findLive(pinnedVenue.id);
      expect(contentModeration.statesForAnyType).not.toHaveBeenCalled();
    });
  });
});
