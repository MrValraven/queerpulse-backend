import { Listing, SafeSpaceStatus } from './entities/listing.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  mapSafeSpaceCategory,
  toDirectoryCard,
  toDirectoryDetail,
  toSafeSpaceCard,
  toSafeSpaceDetail,
} from './listing-response';

function makeListing(overrides: Partial<Listing> = {}): Listing {
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
    alt: { wide: '', d1: '', d2: '', vibe: '' },
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
    ...overrides,
  } as unknown as Listing;
}

describe('directory owner visibility', () => {
  it('exposes the full owner identity when visibility is public', () => {
    const detail = toDirectoryDetail(makeDirectoryListing(), [], []);
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
    expect(detail.vouches[0].initials).toBe('KL');
    expect(detail.promises).toHaveLength(1);
  });
});
