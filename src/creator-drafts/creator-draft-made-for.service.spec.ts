import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { Community } from '../communities/entities/community.entity';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from '../listings/entities/listing-co-manager.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import {
  CreatorDraftMadeForService,
  isListingRef,
} from './creator-draft-made-for.service';

const AUTHOR_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_ID = '22222222-2222-4222-8222-222222222222';
const VENUE_ID = '33333333-3333-4333-8333-333333333333';

describe('CreatorDraftMadeForService', () => {
  let service: CreatorDraftMadeForService;
  const membership = { assertMemberBySlug: jest.fn() };
  const communities = { findOne: jest.fn() };
  const listings = { findOne: jest.fn() };
  const coManagers = { count: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CreatorDraftMadeForService,
        { provide: CommunityMembershipService, useValue: membership },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Listing), useValue: listings },
        { provide: getRepositoryToken(ListingCoManager), useValue: coManagers },
      ],
    }).compile();
    service = moduleRef.get(CreatorDraftMadeForService);
  });

  it('stores the community the author is on, ahead of any listing', async () => {
    membership.assertMemberBySlug.mockResolvedValue('community-1');
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'lisbon-readers',
      name: 'Lisbon Readers',
    });
    listings.findOne.mockResolvedValue({
      id: LISTING_ID,
      ref: 'QPL-2026-0001',
      slug: 'cafe-arco',
      name: 'Café Arco',
      ownerId: AUTHOR_ID,
      status: ListingStatus.Live,
    });
    const refs = await service.resolveEventRefs(AUTHOR_ID, {
      communitySlug: 'lisbon-readers',
      runByListingId: LISTING_ID,
    });
    expect(refs).toEqual(
      expect.objectContaining({
        madeForCommunityId: 'community-1',
        madeForListingId: null,
      }),
    );
    expect(refs.runByListing).toEqual({
      id: LISTING_ID,
      slug: 'cafe-arco',
      name: 'Café Arco',
    });
  });

  it('keeps no community the author is not on and no listing the author does not manage', async () => {
    membership.assertMemberBySlug.mockRejectedValue(
      new ForbiddenException('Only roster members can do that'),
    );
    listings.findOne.mockResolvedValue({
      id: LISTING_ID,
      ownerId: 'someone-else',
      status: ListingStatus.Live,
    });
    coManagers.count.mockResolvedValue(0);
    const refs = await service.resolveEventRefs(AUTHOR_ID, {
      communitySlug: 'not-mine',
      runByListingId: LISTING_ID,
      venueListingId: LISTING_ID,
    });
    expect(refs).toEqual({
      community: null,
      runByListing: null,
      venueListing: null,
      madeForCommunityId: null,
      madeForListingId: null,
    });
  });

  it('falls back from the run-by listing to a venue the author co-manages', async () => {
    listings.findOne.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === VENUE_ID
            ? {
                id: VENUE_ID,
                ownerId: 'owner-2',
                slug: 'bar',
                name: 'Bar',
                ref: 'QPL-2026-0002',
                status: ListingStatus.Review,
              }
            : null,
        ),
    );
    coManagers.count.mockResolvedValue(1);
    const refs = await service.resolveEventRefs(AUTHOR_ID, {
      communitySlug: '',
      runByListingId: null,
      venueListingId: VENUE_ID,
    });
    expect(refs.madeForListingId).toBe(VENUE_ID);
    expect(coManagers.count).toHaveBeenCalledWith({
      where: {
        listingId: VENUE_ID,
        userId: AUTHOR_ID,
        status: ListingCoManagerStatus.Active,
      },
    });
  });

  it('ignores a malformed listing id and an oversized slug without querying', async () => {
    const refs = await service.resolveEventRefs(AUTHOR_ID, {
      communitySlug: 'x'.repeat(121),
      runByListingId: 'not-a-uuid',
      venueListingId: 42,
    });
    expect(refs.madeForListingId).toBeNull();
    expect(listings.findOne).not.toHaveBeenCalled();
    expect(membership.assertMemberBySlug).not.toHaveBeenCalled();
  });

  it('rethrows a database fault from the membership check', async () => {
    membership.assertMemberBySlug.mockRejectedValue(
      new Error('connection reset'),
    );
    await expect(
      service.resolveEventRefs(AUTHOR_ID, { communitySlug: 'lisbon-readers' }),
    ).rejects.toThrow('connection reset');
  });

  it('finds a listing by ref for its owner and answers null for a stranger', async () => {
    listings.findOne.mockResolvedValue({
      id: LISTING_ID,
      ref: 'QPL-2026-0001',
      slug: 'cafe-arco',
      name: 'Café Arco',
      ownerId: AUTHOR_ID,
      status: ListingStatus.Live,
    });
    await expect(
      service.findManageableListingByRef(AUTHOR_ID, 'QPL-2026-0001'),
    ).resolves.toEqual({
      id: LISTING_ID,
      ref: 'QPL-2026-0001',
      slug: 'cafe-arco',
      name: 'Café Arco',
      isLive: true,
    });
    coManagers.count.mockResolvedValue(0);
    await expect(
      service.findManageableListingByRef('stranger-1', 'QPL-2026-0001'),
    ).resolves.toBeNull();
  });

  it.each(['QPL-2026-0001', 'QPL-2026-12345'])(
    'accepts the listing ref shape %s',
    (listingRef) => {
      expect(isListingRef(listingRef)).toBe(true);
    },
  );

  it.each([
    '',
    'QPL-2026-0001\u0000',
    `QPL-2026-${String.fromCharCode(0)}001`,
    'qpl-2026-0001',
    'QPL-26-0001',
    'QPL-2026-001',
    '../QPL-2026-0001',
    'QPL-2026-0001 ',
    `QPL-2026-${'1'.repeat(60)}`,
  ])(
    'refuses the malformed listing ref %j before any query',
    async (listingRef) => {
      expect(isListingRef(listingRef)).toBe(false);
      await expect(
        service.findManageableListingByRef(AUTHOR_ID, listingRef),
      ).resolves.toBeNull();
      await expect(service.findListingIdByRef(listingRef)).resolves.toBeNull();
      expect(listings.findOne).not.toHaveBeenCalled();
      expect(coManagers.count).not.toHaveBeenCalled();
    },
  );

  it('finds the listing id behind a ref without checking who manages it', async () => {
    listings.findOne.mockResolvedValueOnce({ id: LISTING_ID });
    await expect(service.findListingIdByRef('QPL-2026-0001')).resolves.toBe(
      LISTING_ID,
    );
    expect(listings.findOne).toHaveBeenCalledWith({
      where: { ref: 'QPL-2026-0001' },
      select: { id: true },
    });
    expect(coManagers.count).not.toHaveBeenCalled();
    listings.findOne.mockResolvedValueOnce(null);
    await expect(
      service.findListingIdByRef('QPL-2026-0009'),
    ).resolves.toBeNull();
  });
});
