import type { EntityManager } from 'typeorm';
import type { MediaCropService } from '../media-crops/media-crops.service';
import type { Listing } from './entities/listing.entity';
import { toDirectoryCard } from './listing-response';
import { LISTING_TEAM_LISTING_COLUMNS } from './listing-team-response';
import {
  notAdultListingSql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';
import { loadWorksAt } from './listing-team-works-at';

const SUBPROFILE_ID = 'persona-1';

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    ref: 'QPL-2026-0001',
    slug: 'casa-t',
    name: 'Casa T',
    ownerId: 'owner-uuid',
    cats: ['space'],
    hood: 'Anjos',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    blurb: 'A community house.',
    tagline: '',
    tags: [],
    price: '',
    badge: '',
    photoGallery: [],
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {},
    hoursExceptions: [],
    hoursNote: '',
    langs: [],
    whatItIs: [],
    goodFor: [],
    services: [],
    menu: { sections: [], file: null, link: '' },
    pricingMode: 'services',
    accessibilityAnswers: {},
    accessibilityNote: '',
    social: {},
    address: 'R. dos Anjos 1',
    online: false,
    latitude: null,
    longitude: null,
    ownerName: 'Ana Silva',
    ownerRole: '',
    ownerBio: '',
    memberFirst: 'Ana',
    visibility: 'public',
    linkToProfile: true,
    movedToListingId: null,
    safeSpaceStatus: 'none',
    safeSpaceTier: null,
    safeSpaceVerifier: '',
    safeSpaceReVerifiedAt: null,
    safeSpaceSub: '',
    safeSpacePromises: [],
    safeSpaceVouches: [],
    safeSpaceRemoval: null,
    ...overrides,
  } as unknown as Listing;
}

interface ManagerStub {
  query: jest.Mock;
  find: jest.Mock;
}

function makeManager(
  linkRows: { listing_id: string; role_label: string | null }[],
  listings: Listing[],
): ManagerStub {
  return {
    query: jest.fn().mockResolvedValue(linkRows),
    find: jest.fn().mockResolvedValue(listings),
  };
}

function makeMediaCropService(): { getMany: jest.Mock } {
  return { getMany: jest.fn().mockResolvedValue(new Map()) };
}

function recordedSql(manager: ManagerStub): string {
  const firstCall = manager.query.mock.calls[0] as [string, unknown[]];
  return firstCall[0];
}

function recordedParameters(manager: ManagerStub): unknown[] {
  const firstCall = manager.query.mock.calls[0] as [string, unknown[]];
  return firstCall[1];
}

describe('loadWorksAt', () => {
  it('lists accepted links to publicly visible listings in answer order, at most 10', async () => {
    const firstListing = makeListing({
      id: 'listing-1',
      slug: 'casa-t',
      name: 'Casa T',
    });
    const secondListing = makeListing({
      id: 'listing-2',
      slug: 'bar-lumen',
      name: 'Bar Lumen',
    });
    const manager = makeManager(
      [
        { listing_id: 'listing-2', role_label: 'Bartender' },
        { listing_id: 'listing-1', role_label: null },
      ],
      // The listing query answers in its own order; the result follows the
      // link order.
      [firstListing, secondListing],
    );

    const result = await loadWorksAt(
      manager as unknown as EntityManager,
      makeMediaCropService() as unknown as MediaCropService,
      SUBPROFILE_ID,
      true,
    );

    const sql = recordedSql(manager);
    expect(sql).toContain('"listing_team_members" "member"');
    expect(sql).toContain(
      'INNER JOIN "listings" "listing" ON "listing"."id" = "member"."listing_id"',
    );
    expect(sql).toContain('"member"."subprofile_id" = $1');
    expect(sql).toContain(`"member"."status" = 'accepted'`);
    expect(sql).toContain(publiclyVisibleListingSql('listing'));
    expect(sql).toContain(
      'ORDER BY "member"."answered_at" ASC, "member"."id" ASC',
    );
    expect(sql).toContain('LIMIT 10');
    expect(recordedParameters(manager)).toEqual([SUBPROFILE_ID]);
    expect(manager.find).toHaveBeenCalledTimes(1);
    expect(manager.find).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ select: LISTING_TEAM_LISTING_COLUMNS }),
    );
    expect(result.map((worksAt) => worksAt.slug)).toEqual([
      'bar-lumen',
      'casa-t',
    ]);
    expect(result.map((worksAt) => worksAt.roleLabel)).toEqual([
      'Bartender',
      null,
    ]);
  });

  it('shows an 18+ listing to an active member alone', async () => {
    const anonymousManager = makeManager([], []);
    await loadWorksAt(
      anonymousManager as unknown as EntityManager,
      makeMediaCropService() as unknown as MediaCropService,
      SUBPROFILE_ID,
      false,
    );
    expect(recordedSql(anonymousManager)).toContain(
      notAdultListingSql('listing'),
    );

    const memberManager = makeManager([], []);
    await loadWorksAt(
      memberManager as unknown as EntityManager,
      makeMediaCropService() as unknown as MediaCropService,
      SUBPROFILE_ID,
      true,
    );
    expect(recordedSql(memberManager)).not.toContain(
      notAdultListingSql('listing'),
    );
  });

  it('builds works at links with no owner field', async () => {
    const listing = makeListing({
      ownerId: 'owner-uuid',
      ownerName: 'Ana Silva',
      linkToProfile: true,
    });
    const manager = makeManager(
      [{ listing_id: 'listing-1', role_label: 'Resident artist' }],
      [listing],
    );
    const mediaCropService = makeMediaCropService();

    const result = await loadWorksAt(
      manager as unknown as EntityManager,
      mediaCropService as unknown as MediaCropService,
      SUBPROFILE_ID,
      false,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('memberFirst');
    expect(serialized).not.toContain('Ana Silva');
    const card = toDirectoryCard(listing, new Map());
    expect(result).toEqual([
      {
        slug: card.slug,
        name: card.name,
        cat: card.cat,
        coverPhoto: card.coverPhoto,
        tint: card.tint,
        av: card.av,
        roleLabel: 'Resident artist',
      },
    ]);
    expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
  });

  it('skips the listing query when nothing is linked', async () => {
    const manager = makeManager([], []);
    const mediaCropService = makeMediaCropService();

    const result = await loadWorksAt(
      manager as unknown as EntityManager,
      mediaCropService as unknown as MediaCropService,
      SUBPROFILE_ID,
      true,
    );

    expect(result).toEqual([]);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.find).not.toHaveBeenCalled();
    expect(mediaCropService.getMany).not.toHaveBeenCalled();
  });
});
