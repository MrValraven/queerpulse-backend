import { Listing, SafeSpaceStatus } from './entities/listing.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  mapSafeSpaceCategory,
  toDirectoryCard,
  toDirectoryDetail,
  toReviewDTO,
  toSafeSpaceCard,
  toSafeSpaceDetail,
} from './listing-response';

function makeListing(): Listing {
  return {
    slug: 'purex',
    name: 'Purex',
    cats: ['food'],
    hood: 'Intendente',
    blurb: 'A long-running queer bar.',
    tags: ['Bar', 'Trans-welcoming'],
    address: 'R. de São Lázaro 11',
    langs: ['PT', 'EN'],
    safeSpaceStatus: SafeSpaceStatus.Verified,
    safeSpaceTier: 1,
    safeSpaceVerifier: 'Mod team · 2 visits',
    safeSpaceReVerifiedAt: '2026-05-02',
    safeSpaceSub: 'A long-running queer bar.',
    safeSpacePromises: [{ title: 'Staff intervene.', desc: 'Always.' }],
    safeSpaceVouches: [
      { name: 'Kai L', byline: 'Member', text: 'Safe.', when: 'Apr 2026' },
    ],
    safeSpaceRemoval: null,
  } as unknown as Listing;
}

// A listing with everything the public directory builders read, plus a
// nameable owner. Override `visibility` per test.
function makeDirectoryListing(overrides: Partial<Listing> = {}): Listing {
  return {
    slug: 'atelier-pulso',
    name: 'Atelier Pulso',
    cats: ['design'],
    hood: 'Marvila',
    blurb: 'A shared ceramics studio.',
    tagline: 'Hands in clay.',
    tags: ['Studio'],
    price: '€€',
    photoGallery: [],
    // LEGACY derived mirror of the first four `photoGallery` entries.
    alt: { wide: '', d1: '', d2: '', vibe: '' },
    photos: { wide: '', d1: '', d2: '', vibe: '' },
    hours: {},
    langs: [],
    whatItIs: [],
    goodFor: [],
    hoursNote: '',
    social: {},
    address: 'R. do Açúcar 10',
    ownerName: 'Inês Marques',
    ownerRole: 'Ceramicist',
    ownerBio: 'Runs the studio since 2019.',
    visibility: 'public',
    linkToProfile: true,
    // A plain (non-safe-space) directory listing: the detail builder reads
    // these safe-space columns (and spreads `safeSpaceVouches`), so they must
    // be present and iterable even though this listing carries no badge.
    safeSpaceStatus: SafeSpaceStatus.None,
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

describe('directory owner visibility', () => {
  it('exposes the full owner identity when visibility is public', () => {
    const detail = toDirectoryDetail(makeDirectoryListing(), [], [], 0);
    expect(detail.owner.name).toBe('Inês Marques');
    expect(detail.owner.role).toBe('Ceramicist');
    expect(detail.owner.bio).toBe('Runs the studio since 2019.');
    expect(detail.owner.first).toBe('Inês');
    expect(detail.owner.inQueerPulse).toBe(true);
    expect(detail.memberFirst).toBe('Inês');
  });

  it('withholds the real name and profile link for role-only visibility', () => {
    const detail = toDirectoryDetail(
      makeDirectoryListing({ visibility: 'role' }),
      [],
      [],
      0,
    );
    expect(detail.owner.name).toBe('Ceramicist');
    expect(detail.owner.name).not.toContain('Inês');
    expect(detail.owner.first).toBe('');
    expect(detail.owner.inQueerPulse).toBe(false);
    expect(detail.owner.bio).toBe('Runs the studio since 2019.');
    expect(detail.memberFirst).toBeNull();
  });

  it('reveals nothing identifying for an anonymous owner', () => {
    const detail = toDirectoryDetail(
      makeDirectoryListing({ visibility: 'anon' }),
      [],
      [],
      0,
    );
    expect(detail.owner.name).toBe('');
    expect(detail.owner.initials).toBe('');
    expect(detail.owner.role).toBe('');
    expect(detail.owner.bio).toBe('');
    expect(detail.owner.first).toBe('');
    expect(detail.owner.inQueerPulse).toBe(false);
    expect(detail.memberFirst).toBeNull();
  });

  it('drops the grid "run by <first>" line for anon/role listings', () => {
    expect(toDirectoryCard(makeDirectoryListing()).memberFirst).toBe('Inês');
    expect(
      toDirectoryCard(makeDirectoryListing({ visibility: 'anon' })).memberFirst,
    ).toBeNull();
    expect(
      toDirectoryCard(makeDirectoryListing({ visibility: 'role' })).memberFirst,
    ).toBeNull();
  });

  it('redacts the owner photo exactly as it redacts the first name', () => {
    const photo = 'https://cdn.example/ines.jpg';
    expect(
      toDirectoryCard(makeDirectoryListing(), new Map(), undefined, photo)
        .memberAvatarUrl,
    ).toBe(photo);
    // A face names its owner as plainly as a first name does, so every case
    // that withholds the name withholds the photo with it.
    expect(
      toDirectoryCard(
        makeDirectoryListing({ visibility: 'anon' }),
        new Map(),
        undefined,
        photo,
      ).memberAvatarUrl,
    ).toBeNull();
    expect(
      toDirectoryCard(
        makeDirectoryListing({ visibility: 'role' }),
        new Map(),
        undefined,
        photo,
      ).memberAvatarUrl,
    ).toBeNull();
    expect(
      toDirectoryCard(
        makeDirectoryListing({ linkToProfile: false }),
        new Map(),
        undefined,
        photo,
      ).memberAvatarUrl,
    ).toBeNull();
  });
});

describe('toDirectoryDetail', () => {
  it('surfaces real photo urls, alt text, hours and langs on the detail DTO', () => {
    const listing = makeDirectoryListing();
    listing.photoGallery = [
      {
        image: 'https://cdn.example.com/wide.jpg',
        alt: 'Main room',
        caption: '',
      },
      { image: 'https://cdn.example.com/d1.jpg', alt: 'The bar', caption: '' },
      { image: 'https://cdn.example.com/vibe.jpg', alt: 'Crowd', caption: '' },
    ];
    listing.hours = {
      Fri: { open: true, intervals: [{ from: '18:00', to: '02:00' }] },
    };
    listing.langs = ['pt', 'en'];

    const detail = toDirectoryDetail(listing, [], [], 0);

    // The ordered gallery is the shape the frontend builds against.
    expect(detail.photoGallery.map((photo) => photo.image)).toEqual([
      'https://cdn.example.com/wide.jpg',
      'https://cdn.example.com/d1.jpg',
      'https://cdn.example.com/vibe.jpg',
    ]);
    expect(detail.photoGallery[0]?.alt).toBe('Main room');
    // The LEGACY four-slot fields are derived from the gallery IN ORDER, so a
    // three-photo listing fills wide/d1/d2 and leaves `vibe` empty. They are a
    // compatibility surface, never a second source of truth.
    expect(detail.photos.wide).toBe('https://cdn.example.com/wide.jpg');
    expect(detail.photos.d1).toBe('https://cdn.example.com/d1.jpg');
    expect(detail.photos.d2).toBe('https://cdn.example.com/vibe.jpg');
    expect(detail.photos.vibe).toBeNull(); // no fourth photo → null
    expect(detail.alt.wide).toBe('Main room');
    // Hours pass through in the current interval-based shape (the flat
    // open/from/to model was superseded by the RewriteListingHoursToIntervals
    // migration — see `ListingDayHours`).
    expect(detail.hours.Fri).toEqual({
      open: true,
      intervals: [{ from: '18:00', to: '02:00' }],
    });
    expect(detail.langs).toEqual(['pt', 'en']);
  });

  it('passes the saved-item count straight through as savedCount', () => {
    const withNone = toDirectoryDetail(makeDirectoryListing(), [], [], 0);
    expect(withNone.savedCount).toBe(0);

    const withSome = toDirectoryDetail(makeDirectoryListing(), [], [], 7);
    expect(withSome.savedCount).toBe(7);
  });
});

describe('safe-space adapters', () => {
  it('maps a bar listing to the Bar category via tags', () => {
    expect(mapSafeSpaceCategory(['food'], ['Bar'])).toBe('Bar');
  });

  it('falls back to Services for unmapped categories', () => {
    expect(mapSafeSpaceCategory(['mystery'], [])).toBe('Services');
  });

  it('builds a card with derived rating from reviews', () => {
    const reviews = [{ stars: 5 }, { stars: 4 }] as ListingReview[];
    const card = toSafeSpaceCard(makeListing(), reviews);
    expect(card.name).toBe('Purex');
    expect(card.cat).toBe('Bar');
    expect(card.rating).toBe('4.5');
    expect(card.reviews).toBe(2);
    expect(card.tier).toBe(1);
  });

  it('derives vouch initials in the detail payload', () => {
    const detail = toSafeSpaceDetail(makeListing(), []);
    expect(detail.status).toBe('verified');
    expect(detail.vouches[0]!.initials).toBe('KL');
    expect(detail.promises).toHaveLength(1);
  });
});

describe('toReviewDTO', () => {
  const WRITTEN_AT = new Date('2026-03-01T10:00:00.000Z');

  function makeReview(overrides: Partial<ListingReview> = {}): ListingReview {
    return {
      id: 'review-1',
      listingId: 'listing-1',
      reviewerId: 'member-1',
      reviewerName: 'Ana Silva',
      byline: 'she/her',
      stars: 4,
      text: 'Warm staff, easy to get into.',
      photo: '',
      helpful: 0,
      ownerReplyText: null,
      ownerRepliedAt: null,
      editedAt: null,
      createdAt: WRITTEN_AT,
      ...overrides,
    } as ListingReview;
  }

  it('dates the review, which is the whole point of exposing createdAt', () => {
    const dto = toReviewDTO(makeReview());
    expect(dto.createdAt).toBe('2026-03-01T10:00:00.000Z');
    expect(dto.editedAt).toBeNull();
    expect(dto.isEditedAfterOwnerReply).toBe(false);
  });

  it('reports an edit that came after the owner replied', () => {
    const dto = toReviewDTO(
      makeReview({
        ownerReplyText: 'Thanks for coming by.',
        ownerRepliedAt: new Date('2026-03-02T10:00:00.000Z'),
        editedAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    // The reply is still there. An edit must never be able to delete the
    // business's public response.
    expect(dto.ownerReply).toEqual({
      text: 'Thanks for coming by.',
      at: '2026-03-02T10:00:00.000Z',
    });
    // And the page can say the words changed after that reply was written.
    expect(dto.isEditedAfterOwnerReply).toBe(true);
  });

  it('does not report an edit that came BEFORE the owner replied', () => {
    const dto = toReviewDTO(
      makeReview({
        ownerReplyText: 'Thanks, we have fixed the ramp.',
        ownerRepliedAt: new Date('2026-03-05T10:00:00.000Z'),
        editedAt: new Date('2026-03-03T10:00:00.000Z'),
      }),
    );

    // The owner replied to the review as it now stands, so there is nothing to
    // flag — this is the ordinary case and must not be marked as suspicious.
    expect(dto.editedAt).toBe('2026-03-03T10:00:00.000Z');
    expect(dto.isEditedAfterOwnerReply).toBe(false);
  });

  it('stays false for an edited review nobody replied to', () => {
    const dto = toReviewDTO(
      makeReview({ editedAt: new Date('2026-03-03T10:00:00.000Z') }),
    );
    expect(dto.isEditedAfterOwnerReply).toBe(false);
  });

  it('reads an empty photo slot as no photo', () => {
    expect(toReviewDTO(makeReview()).photoUrl).toBeNull();
  });
});

describe('listing photo gallery on the response DTOs', () => {
  const galleryListing = () =>
    makeDirectoryListing({
      photoGallery: [
        {
          image: 'listing-photos/u/cover.jpg',
          alt: 'The shopfront',
          caption: 'Since 2019',
        },
        {
          image: 'listing-photos/u/second.jpg',
          alt: 'The wheel room',
          caption: '',
        },
        {
          image: 'listing-photos/u/third.jpg',
          alt: 'Glaze shelf',
          caption: '',
        },
        { image: 'listing-photos/u/fourth.jpg', alt: 'The kiln', caption: '' },
        {
          image: 'listing-photos/u/fifth.jpg',
          alt: 'Open studio night',
          caption: 'Every first Friday',
        },
      ],
    });

  it('keeps alt text and caption as separate per-photo fields', () => {
    const detail = toDirectoryDetail(galleryListing(), [], [], 0);
    const cover = detail.photoGallery[0];
    expect(cover?.alt).toBe('The shopfront');
    expect(cover?.caption).toBe('Since 2019');
    // A photo with a caption and one without both keep a real alt string.
    expect(detail.photoGallery[1]?.alt).toBe('The wheel room');
    expect(detail.photoGallery[1]?.caption).toBe('');
  });

  it('serves every photo past the fourth, which the old slots could not hold', () => {
    const detail = toDirectoryDetail(galleryListing(), [], [], 0);
    expect(detail.photoGallery).toHaveLength(5);
    expect(detail.photoGallery[4]?.alt).toBe('Open studio night');
  });

  it('puts the first gallery entry on the card as the cover photo', () => {
    const card = toDirectoryCard(galleryListing());
    expect(card.coverPhoto?.alt).toBe('The shopfront');
    expect(card.coverPhoto?.caption).toBe('Since 2019');
  });

  it('gives a photoless listing a null cover and an empty gallery', () => {
    const card = toDirectoryCard(makeDirectoryListing());
    expect(card.coverPhoto).toBeNull();
    const detail = toDirectoryDetail(makeDirectoryListing(), [], [], 0);
    expect(detail.photoGallery).toEqual([]);
  });

  it('falls back to alt text for the legacy caption strip, preferring a real caption', () => {
    const detail = toDirectoryDetail(galleryListing(), [], [], 0);
    expect(detail.gallery).toEqual([
      'Since 2019',
      'The wheel room',
      'Glaze shelf',
      'The kiln',
      'Every first Friday',
    ]);
  });
});
