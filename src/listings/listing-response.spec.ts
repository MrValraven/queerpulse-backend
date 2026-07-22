import { Listing, SafeSpaceStatus } from './entities/listing.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  mapSafeSpaceCategory,
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
