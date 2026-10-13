import {
  COMMON_LISTING_LANGUAGE_CODES,
  FILTERABLE_LISTING_ATTRIBUTE_SLUGS,
  LEGACY_LANGUAGE_NAME_CODES,
  LISTING_ATTRIBUTE_GROUPS,
  LISTING_ATTRIBUTE_SLUGS,
  LISTING_INCLUSION_PRACTICE_SCOPES,
  LISTING_LANGUAGE_CODES,
  LISTING_LANGUAGE_NAMES,
  PREMISES_ONLY_ATTRIBUTE_SLUGS,
  SENSITIVE_ATTRIBUTE_SLUGS,
  isListingAttributeOffered,
  isListingInclusionPracticeOffered,
  legacyLanguageNamesToCodes,
  listingLanguageLabels,
  normalizeListingAttributes,
  normalizeListingInclusionPractices,
  normalizeListingPayments,
  offeredListingAttributeSlugs,
  toListingAttributeVocabularyDTO,
} from './listing-attributes';
import type { ListingKind } from './listing-mobile-details';

describe('the listing attribute vocabulary', () => {
  it('lists the groups in the contract order', () => {
    expect(LISTING_ATTRIBUTE_GROUPS.map((group) => group.id)).toEqual([
      'around',
      'food',
      'nightlife',
      'culture',
      'space',
      'grooming',
      'fitness',
      'health',
      'design',
      'tech',
      'tours',
      'home-services',
      'onlineOffering',
      'onlineFood',
      'onlineOrdering',
      'onlineSessions',
      'pricing',
    ]);
  });

  it('knows 88 slugs, each lowercase kebab case and at most 40 characters', () => {
    expect(LISTING_ATTRIBUTE_SLUGS).toHaveLength(88);
    for (const slug of LISTING_ATTRIBUTE_SLUGS) {
      expect(slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(40);
    }
  });

  it('takes every premises-only and sensitive slug from the vocabulary itself', () => {
    expect(PREMISES_ONLY_ATTRIBUTE_SLUGS).toHaveLength(14);
    for (const slug of [
      ...PREMISES_ONLY_ATTRIBUTE_SLUGS,
      ...SENSITIVE_ATTRIBUTE_SLUGS,
    ]) {
      expect(LISTING_ATTRIBUTE_SLUGS).toContain(slug);
    }
  });

  it('leaves the two sensitive slugs out of the filterable list', () => {
    expect(FILTERABLE_LISTING_ATTRIBUTE_SLUGS).toHaveLength(86);
    expect(FILTERABLE_LISTING_ATTRIBUTE_SLUGS).not.toContain(
      'sexual-health-prep',
    );
    expect(FILTERABLE_LISTING_ATTRIBUTE_SLUGS).not.toContain(
      'trans-care-experience',
    );
  });

  it('offers pricing to every kind of listing', () => {
    const pricingGroup = LISTING_ATTRIBUTE_GROUPS.find(
      (group) => group.id === 'pricing',
    );
    expect(pricingGroup?.kinds).toEqual(['place', 'mobile', 'online']);
    expect(pricingGroup?.categories).toBeNull();
  });
});

describe('offeredListingAttributeSlugs', () => {
  it('offers a barbershop the universal, grooming and pricing groups and nothing from a bar', () => {
    const offered = offeredListingAttributeSlugs('place', ['grooming']);

    expect(offered.has('terrace')).toBe(true);
    expect(offered.has('priced-by-service')).toBe(true);
    expect(offered.has('sliding-scale')).toBe(true);
    expect(offered.has('dj-nights')).toBe(false);
    expect(offered.has('vegan-options')).toBe(false);
  });

  it('never offers a premises-only slug to an out and about listing', () => {
    const offered = offeredListingAttributeSlugs('mobile', [
      'grooming',
      'tours',
    ]);

    expect(offered.has('terrace')).toBe(false);
    expect(offered.has('private-room')).toBe(false);
    expect(offered.has('kid-friendly')).toBe(true);
    expect(offered.has('walking-tours')).toBe(true);
    expect(offered.has('makeup')).toBe(true);
  });

  it('offers an online food shop the online groups and pricing, and no place group', () => {
    const offered = offeredListingAttributeSlugs('online', ['food']);

    expect(offered.has('vegan-options')).toBe(true);
    expect(offered.has('by-appointment')).toBe(true);
    expect(offered.has('gift-cards')).toBe(true);
    expect(offered.has('free-first-call')).toBe(true);
    expect(offered.has('pay-what-you-can')).toBe(true);
    expect(offered.has('terrace')).toBe(false);
    expect(offered.has('halal')).toBe(false);
  });

  it('offers a slug that sits in two groups when either group fits', () => {
    expect(isListingAttributeOffered('second-hand', 'place', ['design'])).toBe(
      true,
    );
    expect(isListingAttributeOffered('second-hand', 'place', ['culture'])).toBe(
      true,
    );
    expect(isListingAttributeOffered('second-hand', 'place', ['food'])).toBe(
      false,
    );
  });

  it('offers nothing outside the vocabulary', () => {
    expect(isListingAttributeOffered('rooftop-pool', 'place', ['food'])).toBe(
      false,
    );
  });
});

describe('normalizeListingAttributes', () => {
  it('trims, lowercases and drops repeats, keeping the order sent', () => {
    expect(
      normalizeListingAttributes(
        [' DJ-Nights ', 'terrace', 'dj-nights', ''],
        [],
        'place',
        ['nightlife'],
      ),
    ).toEqual({
      attributes: ['dj-nights', 'terrace'],
      unknown: [],
      notOffered: [],
    });
  });

  it('names every slug the vocabulary does not know', () => {
    expect(
      normalizeListingAttributes(
        ['terrace', 'rooftop-pool', 'sauna'],
        [],
        'place',
        ['food'],
      ),
    ).toEqual({
      attributes: ['terrace'],
      unknown: ['rooftop-pool', 'sauna'],
      notOffered: [],
    });
  });

  it('names a known slug this listing is not offered', () => {
    expect(
      normalizeListingAttributes(['dj-nights'], [], 'place', ['grooming'])
        .notOffered,
    ).toEqual(['dj-nights']);
  });

  it('keeps a slug the listing already carries after its categories changed', () => {
    expect(
      normalizeListingAttributes(
        ['dj-nights', 'priced-by-service'],
        ['dj-nights'],
        'place',
        ['grooming'],
      ),
    ).toEqual({
      attributes: ['dj-nights', 'priced-by-service'],
      unknown: [],
      notOffered: [],
    });
  });

  it('reads a missing request and a missing stored list as empty', () => {
    expect(normalizeListingAttributes(undefined, null, 'place', [])).toEqual({
      attributes: [],
      unknown: [],
      notOffered: [],
    });
  });
});

describe('inclusion practices', () => {
  it.each([
    ['chosen-name', 'online', [], true],
    ['safer-space-policy', 'online', [], true],
    ['named-contact', 'mobile', [], true],
    ['named-contact', 'online', [], false],
    ['harm-reduction', 'place', ['nightlife'], true],
    ['harm-reduction', 'mobile', ['nightlife'], true],
    ['harm-reduction', 'place', ['food'], false],
    ['harm-reduction', 'online', ['nightlife'], false],
  ] as [string, ListingKind, string[], boolean][])(
    'offers %s to a %s listing in %j: %s',
    (practice, kind, categories, isExpectedOffered) => {
      expect(
        isListingInclusionPracticeOffered(practice, kind, categories),
      ).toBe(isExpectedOffered);
    },
  );

  it('stores practices in vocabulary order and keeps a stored one outside its scope', () => {
    expect(
      normalizeListingInclusionPractices(
        ['harm-reduction', 'chosen-name'],
        ['harm-reduction'],
        'place',
        ['food'],
      ),
    ).toEqual({
      inclusionPractices: ['chosen-name', 'harm-reduction'],
      notOffered: [],
    });
  });

  it('names a new practice outside its scope', () => {
    expect(
      normalizeListingInclusionPractices(['named-contact'], [], 'online', [
        'classes',
      ]).notOffered,
    ).toEqual(['named-contact']);
  });

  it('serves the four scopes in vocabulary order', () => {
    expect(
      LISTING_INCLUSION_PRACTICE_SCOPES.map((scope) => scope.slug),
    ).toEqual([
      'chosen-name',
      'safer-space-policy',
      'named-contact',
      'harm-reduction',
    ]);
  });
});

describe('normalizeListingPayments', () => {
  it('keeps known methods once each, in vocabulary order', () => {
    expect(
      normalizeListingPayments(['cash', 'card', 'cash', 'paypal', 7]),
    ).toEqual(['card', 'cash']);
  });

  it('reads a missing list as empty', () => {
    expect(normalizeListingPayments(null)).toEqual([]);
  });
});

describe('languages', () => {
  it('knows 17 codes, five of them common, each with its own name', () => {
    expect(LISTING_LANGUAGE_CODES).toHaveLength(17);
    expect(COMMON_LISTING_LANGUAGE_CODES).toEqual([
      'pt',
      'pt-BR',
      'en',
      'es',
      'fr',
    ]);
    for (const code of LISTING_LANGUAGE_CODES) {
      expect(LISTING_LANGUAGE_NAMES[code]).toBeTruthy();
    }
  });

  it('labels codes by their own names and adds the free text last, trimmed', () => {
    expect(listingLanguageLabels(['pt', 'pt-BR', 'lgp'], '  Tetum ')).toEqual([
      'Português',
      'Português (Brasil)',
      'LGP (língua gestual)',
      'Tetum',
    ]);
  });

  it('keeps a value it has no name for as written', () => {
    expect(listingLanguageLabels(['Klingon', 'constructor'], '')).toEqual([
      'Klingon',
      'constructor',
    ]);
  });
});

describe('legacyLanguageNamesToCodes', () => {
  it('maps each of the six legacy names to its code', () => {
    expect(LEGACY_LANGUAGE_NAME_CODES).toEqual({
      Português: 'pt',
      'Português (Brasil)': 'pt-BR',
      English: 'en',
      Español: 'es',
      Français: 'fr',
      'LGP (sign)': 'lgp',
    });
    expect(
      legacyLanguageNamesToCodes([
        'Português',
        'Português (Brasil)',
        'English',
        'Español',
        'Français',
        'LGP (sign)',
      ]),
    ).toEqual(['pt', 'pt-BR', 'en', 'es', 'fr', 'lgp']);
  });

  it('matches a name trimmed and in any case', () => {
    expect(
      legacyLanguageNamesToCodes([
        '  english ',
        'PORTUGUÊS (BRASIL)',
        'lgp (SIGN)',
      ]),
    ).toEqual(['en', 'pt-BR', 'lgp']);
  });

  it('matches a name written in decomposed (NFD) form', () => {
    expect(legacyLanguageNamesToCodes(['Português'.normalize('NFD')])).toEqual([
      'pt',
    ]);
  });

  it('drops "Other" in any case', () => {
    expect(legacyLanguageNamesToCodes(['Other', ' other ', 'en'])).toEqual([
      'en',
    ]);
  });

  it('passes codes and unknown strings through as sent', () => {
    expect(legacyLanguageNamesToCodes(['pt', 'Klingon', 'pt-br'])).toEqual([
      'pt',
      'Klingon',
      'pt-br',
    ]);
  });

  it('dedupes a name and its code, keeping the first position', () => {
    expect(
      legacyLanguageNamesToCodes(['fr', 'English', 'Français', 'en', 'fr']),
    ).toEqual(['fr', 'en']);
  });

  it('keeps a non-string entry for the validators to reject', () => {
    expect(legacyLanguageNamesToCodes(['English', 7, null])).toEqual([
      'en',
      7,
      null,
    ]);
  });

  it('returns a value that is not an array untouched', () => {
    expect(legacyLanguageNamesToCodes('English')).toBe('English');
    expect(legacyLanguageNamesToCodes(undefined)).toBeUndefined();
    expect(legacyLanguageNamesToCodes(null)).toBeNull();
    const body = { langs: ['English'] };
    expect(legacyLanguageNamesToCodes(body)).toBe(body);
  });

  it('leaves the array it was given unchanged', () => {
    const sent = ['English', 'Other'];
    legacyLanguageNamesToCodes(sent);
    expect(sent).toEqual(['English', 'Other']);
  });
});

describe('toListingAttributeVocabularyDTO', () => {
  it('serves every group with its scope, and the flags and languages', () => {
    const vocabulary = toListingAttributeVocabularyDTO();

    expect(vocabulary.groups).toHaveLength(17);
    expect(vocabulary.groups.find((group) => group.id === 'nightlife')).toEqual(
      {
        id: 'nightlife',
        kinds: ['place', 'mobile'],
        categories: ['nightlife'],
        attributes: [
          'live-music',
          'dj-nights',
          'drag-shows',
          'karaoke',
          'dancefloor',
          'quiet-corner',
          'alcohol-free-drinks',
          'smoking-area',
          'coat-check',
          'adults-only',
        ],
      },
    );
    expect(vocabulary.premisesOnly).toEqual([...PREMISES_ONLY_ATTRIBUTE_SLUGS]);
    expect(vocabulary.sensitive).toEqual([
      'sexual-health-prep',
      'trans-care-experience',
    ]);
    expect(vocabulary.inclusionPractices).toEqual([
      {
        slug: 'chosen-name',
        kinds: ['place', 'mobile', 'online'],
        categories: null,
      },
      {
        slug: 'safer-space-policy',
        kinds: ['place', 'mobile', 'online'],
        categories: null,
      },
      { slug: 'named-contact', kinds: ['place', 'mobile'], categories: null },
      {
        slug: 'harm-reduction',
        kinds: ['place', 'mobile'],
        categories: ['nightlife'],
      },
    ]);
    expect(vocabulary.languages).toEqual([...LISTING_LANGUAGE_CODES]);
    expect(vocabulary.commonLanguages).toEqual([
      ...COMMON_LISTING_LANGUAGE_CODES,
    ]);
  });

  it('hands out copies, so a caller mutating the response leaves the vocabulary intact', () => {
    const vocabulary = toListingAttributeVocabularyDTO();
    vocabulary.groups[0]?.attributes.push('invented');
    vocabulary.premisesOnly.push('invented');

    expect(LISTING_ATTRIBUTE_GROUPS[0]?.attributes).not.toContain('invented');
    expect(toListingAttributeVocabularyDTO().premisesOnly).not.toContain(
      'invented',
    );
  });
});
