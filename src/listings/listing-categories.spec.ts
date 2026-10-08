import {
  ADULT_LISTING_CATEGORY_SLUG,
  ALL_LISTING_CATEGORY_SLUGS,
  LISTING_CATEGORY_SLUGS,
  ONLINE_LISTING_CATEGORY_SLUGS,
  isAdultListing,
  isListingCategoryOffered,
} from './listing-categories';

describe('listing categories by kind of listing', () => {
  it('offers food to places and to online listings', () => {
    expect(isListingCategoryOffered('food', false)).toBe(true);
    expect(isListingCategoryOffered('food', true)).toBe(true);
  });

  it('offers the online vocabulary to online listings only', () => {
    expect(isListingCategoryOffered('apparel', true)).toBe(true);
    expect(isListingCategoryOffered('apparel', false)).toBe(false);
  });

  it('offers the place vocabulary to places only', () => {
    expect(isListingCategoryOffered('nightlife', false)).toBe(true);
    expect(isListingCategoryOffered('nightlife', true)).toBe(false);
  });

  it('keeps the 18+ category out of the place vocabulary', () => {
    expect(isListingCategoryOffered(ADULT_LISTING_CATEGORY_SLUG, false)).toBe(
      false,
    );
    expect(LISTING_CATEGORY_SLUGS as readonly string[]).not.toContain(
      ADULT_LISTING_CATEGORY_SLUG,
    );
  });

  it('lists every slug of both vocabularies exactly once', () => {
    const expectedSlugs = [
      ...new Set<string>([
        ...LISTING_CATEGORY_SLUGS,
        ...ONLINE_LISTING_CATEGORY_SLUGS,
      ]),
    ];
    expect([...ALL_LISTING_CATEGORY_SLUGS].sort()).toEqual(
      expectedSlugs.sort(),
    );
    expect(
      ALL_LISTING_CATEGORY_SLUGS.filter((slug) => slug === 'food'),
    ).toHaveLength(1);
  });

  it('reads a listing as 18+ only when it carries the intimacy category', () => {
    expect(isAdultListing(['handmade', 'intimacy'])).toBe(true);
    expect(isAdultListing(['handmade'])).toBe(false);
    expect(isAdultListing(undefined)).toBe(false);
    expect(isAdultListing(null)).toBe(false);
  });
});

describe('the tours and home-services categories', () => {
  it('closes the place list in the contract order', () => {
    expect(LISTING_CATEGORY_SLUGS.slice(-3)).toEqual([
      'nightlife',
      'tours',
      'home-services',
    ]);
    expect(LISTING_CATEGORY_SLUGS).toHaveLength(11);
  });

  it('are offered to places, and so to mobile listings, which use the place list', () => {
    expect(isListingCategoryOffered('tours', false)).toBe(true);
    expect(isListingCategoryOffered('home-services', false)).toBe(true);
  });

  it('are never offered to online-only listings', () => {
    expect(isListingCategoryOffered('tours', true)).toBe(false);
    expect(isListingCategoryOffered('home-services', true)).toBe(false);
  });

  it('pass the DTO vocabulary, each once', () => {
    expect(ALL_LISTING_CATEGORY_SLUGS).toContain('tours');
    expect(
      ALL_LISTING_CATEGORY_SLUGS.filter((slug) => slug === 'home-services'),
    ).toHaveLength(1);
  });

  it('carry no 18+ meaning', () => {
    expect(isAdultListing(['tours', 'home-services'])).toBe(false);
  });
});
