import { Repository } from 'typeorm';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';
import { toMySuggestedListingDTO } from './my-suggested-listing-response';
import { MySuggestedListingsService } from './my-suggested-listings.service';

const SUGGESTER_ID = 'suggester-1';

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    ref: 'QPL-2026-0007',
    name: 'Café Arco',
    city: 'Lisbon',
    slug: 'cafe-arco',
    status: ListingStatus.Review,
    ownerId: null,
    suggestedByUserId: SUGGESTER_ID,
    isHiddenByOwner: false,
    operatingState: ListingOperatingState.Open,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  } as Listing;
}

describe('MySuggestedListingsService (PRD-434)', () => {
  let queryBuilder: {
    where: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let service: MySuggestedListingsService;

  beforeEach(() => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as Repository<Listing>;
    service = new MySuggestedListingsService(repository);
  });

  it('reads only the listings the caller suggested, newest first', async () => {
    await service.listMine(SUGGESTER_ID, 2);

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'listing.suggestedByUserId = :userId',
      { userId: SUGGESTER_ID },
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'listing.createdAt',
      'DESC',
    );
    expect(queryBuilder.skip).toHaveBeenCalledWith(20);
    expect(queryBuilder.take).toHaveBeenCalledWith(20);
  });

  it('returns the paginated envelope with each row hand-mapped', async () => {
    queryBuilder.getManyAndCount.mockResolvedValue([[makeListing()], 1]);

    const result = await service.listMine(SUGGESTER_ID);

    expect(result).toEqual({
      items: [
        {
          ref: 'QPL-2026-0007',
          name: 'Café Arco',
          city: 'Lisbon',
          state: 'in_review',
          holder: 'platform',
          publicSlug: null,
          isPermanentlyClosed: false,
          suggestedAt: '2026-09-01T10:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });
});

describe('toMySuggestedListingDTO', () => {
  it('maps every moderation status to a suggester state', () => {
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Review }),
        SUGGESTER_ID,
      ).state,
    ).toBe('in_review');
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Question }),
        SUGGESTER_ID,
      ).state,
    ).toBe('needs_info');
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Live }),
        SUGGESTER_ID,
      ).state,
    ).toBe('published');
  });

  it('carries the public slug only while the public page resolves', () => {
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Live }),
        SUGGESTER_ID,
      ).publicSlug,
    ).toBe('cafe-arco');
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Live, isHiddenByOwner: true }),
        SUGGESTER_ID,
      ).publicSlug,
    ).toBeNull();
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Question }),
        SUGGESTER_ID,
      ).publicSlug,
    ).toBeNull();
  });

  it('says who holds the listing now', () => {
    expect(
      toMySuggestedListingDTO(makeListing({ ownerId: null }), SUGGESTER_ID)
        .holder,
    ).toBe('platform');
    expect(
      toMySuggestedListingDTO(
        makeListing({ ownerId: SUGGESTER_ID }),
        SUGGESTER_ID,
      ).holder,
    ).toBe('claimed_by_you');
    expect(
      toMySuggestedListingDTO(
        makeListing({ ownerId: 'business-owner-1' }),
        SUGGESTER_ID,
      ).holder,
    ).toBe('claimed');
  });

  it('never carries owner identity or contact fields', () => {
    const dto = toMySuggestedListingDTO(
      makeListing({
        ownerId: 'business-owner-1',
        ownerName: 'Owner Name',
        contactEmail: 'owner@example.com',
      }),
      SUGGESTER_ID,
    );
    expect(Object.keys(dto).sort()).toEqual(
      [
        'city',
        'holder',
        'isPermanentlyClosed',
        'name',
        'publicSlug',
        'ref',
        'state',
        'suggestedAt',
      ].sort(),
    );
  });

  it("keeps a claimed listing's review state with its business", () => {
    for (const status of [ListingStatus.Review, ListingStatus.Question]) {
      const dto = toMySuggestedListingDTO(
        makeListing({ status, ownerId: 'business-owner-1' }),
        SUGGESTER_ID,
      );
      expect(dto.state).toBe('with_business');
      expect(dto.publicSlug).toBeNull();
    }
    expect(
      toMySuggestedListingDTO(
        makeListing({
          status: ListingStatus.Live,
          ownerId: 'business-owner-1',
          isHiddenByOwner: true,
          operatingState: ListingOperatingState.PermanentlyClosed,
        }),
        SUGGESTER_ID,
      ),
    ).toEqual(
      expect.objectContaining({
        state: 'with_business',
        publicSlug: null,
        isPermanentlyClosed: false,
      }),
    );
  });

  it('shows a claimed listing as published while its public page opens', () => {
    expect(
      toMySuggestedListingDTO(
        makeListing({
          status: ListingStatus.Live,
          ownerId: 'business-owner-1',
        }),
        SUGGESTER_ID,
      ),
    ).toEqual(
      expect.objectContaining({
        state: 'published',
        holder: 'claimed',
        publicSlug: 'cafe-arco',
      }),
    );
  });

  it('shows the suggester their own review state once they claimed it', () => {
    expect(
      toMySuggestedListingDTO(
        makeListing({ status: ListingStatus.Question, ownerId: SUGGESTER_ID }),
        SUGGESTER_ID,
      ).state,
    ).toBe('needs_info');
  });

  it('flags a business that has closed for good', () => {
    expect(
      toMySuggestedListingDTO(
        makeListing({
          status: ListingStatus.Live,
          operatingState: ListingOperatingState.PermanentlyClosed,
        }),
        SUGGESTER_ID,
      ).isPermanentlyClosed,
    ).toBe(true);
  });
});
