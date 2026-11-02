import {
  toAdminDirectoryPartner,
  toAdminDirectoryPartnerSearchResult,
} from './directory-partners-response';
import type { Listing } from './entities/listing.entity';
import { initialsForName, tintForSlug, toCoverPhoto } from './listing-response';

const PICK_ID = '11111111-1111-4111-8111-111111111111';
const LISTING_ID = '22222222-2222-4222-8222-222222222222';

function buildListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: LISTING_ID,
    ref: 'QPL-2026-0007',
    slug: 'casa-t',
    name: 'Casa T',
    cats: ['space', 'food'],
    hood: 'Anjos',
    coverPhoto: { image: '/uploads/own-cover.jpg', alt: 'Front door' },
    photoGallery: [{ image: '/uploads/first-gallery.jpg', alt: 'Bar' }],
    ...overrides,
  } as unknown as Listing;
}

describe('toAdminDirectoryPartner', () => {
  it('maps the pick and its listing onto the admin row', () => {
    const listing = buildListing();
    const row = toAdminDirectoryPartner(
      { id: PICK_ID, note: 'Members get 10% off', position: 2 },
      listing,
      'moderated',
    );
    expect(row).toEqual({
      id: PICK_ID,
      listingId: LISTING_ID,
      listingRef: 'QPL-2026-0007',
      slug: 'casa-t',
      name: 'Casa T',
      cat: 'space',
      hood: 'Anjos',
      tint: tintForSlug('casa-t'),
      av: 'CT',
      note: 'Members get 10% off',
      position: 2,
      publicState: 'moderated',
      coverImage: toCoverPhoto(listing)?.image ?? null,
    });
  });

  it('uses the cover the public card shows: own cover, then first gallery photo, then null', () => {
    const withOwnCover = buildListing();
    const withGalleryOnly = buildListing({ coverPhoto: null });
    const withNoPhotos = buildListing({ coverPhoto: null, photoGallery: [] });
    const pick = { id: PICK_ID, note: null, position: 1 };
    expect(
      toAdminDirectoryPartner(pick, withOwnCover, 'showing').coverImage,
    ).toBe(toCoverPhoto(withOwnCover)?.image ?? null);
    expect(
      toAdminDirectoryPartner(pick, withGalleryOnly, 'showing').coverImage,
    ).toBe(toCoverPhoto(withGalleryOnly)?.image ?? null);
    expect(
      toAdminDirectoryPartner(pick, withNoPhotos, 'showing').coverImage,
    ).toBeNull();
  });

  it('carries no creator field', () => {
    const row = toAdminDirectoryPartner(
      { id: PICK_ID, note: null, position: 1 },
      buildListing(),
      'showing',
    );
    expect(Object.keys(row)).not.toContain('createdById');
  });
});

describe('toAdminDirectoryPartnerSearchResult', () => {
  it('maps a search row and marks a picked listing', () => {
    const result = toAdminDirectoryPartnerSearchResult(
      {
        id: LISTING_ID,
        slug: 'casa-t',
        name: 'Casa T',
        cats: ['space', 'food'],
        hood: 'Anjos',
      },
      true,
    );
    expect(result).toEqual({
      listingId: LISTING_ID,
      slug: 'casa-t',
      name: 'Casa T',
      cat: 'space',
      hood: 'Anjos',
      tint: tintForSlug('casa-t'),
      av: initialsForName('Casa T'),
      isPartner: true,
    });
  });
});
