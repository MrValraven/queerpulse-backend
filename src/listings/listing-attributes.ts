import type { ListingKind } from './listing-mobile-details';

/**
 * The listing attribute vocabulary and the structured vocabularies beside it
 * (`QUEERPULSE-LISTING-ATTRIBUTES-CONTRACT-2026-10-08.md`).
 *
 * Attributes are yes facts an owner ticks about their business ("Terrace",
 * "Drag shows", "Takes health insurance"). Each group is offered to some kinds
 * of listing and, optionally, to some categories only, so a barbershop never
 * sees "DJ nights". The structured vocabularies answer one question each: how
 * people get in, the entry charge, ways to pay, inclusion practices and the
 * languages spoken.
 *
 * Stored values are these slugs, verbatim, in `listings.attributes`,
 * `listings.highlights`, `listings.payments`, `listings.inclusion_practices`
 * and `listings.langs`. The frontend keeps an identical copy and translates
 * every slug for display, so renaming one is a data change that needs a
 * migration and a matching catalog entry on the frontend.
 *
 * Served as-is by `GET /directory/attributes`
 * (`toListingAttributeVocabularyDTO`), so the owner picker and the write rules
 * (`listing-attribute-rules.ts`) read one list. Replaces `listing-tags.ts`.
 */

export type ListingAttributeGroupId =
  | 'around'
  | 'food'
  | 'nightlife'
  | 'culture'
  | 'space'
  | 'grooming'
  | 'fitness'
  | 'health'
  | 'design'
  | 'tech'
  | 'tours'
  | 'home-services'
  | 'onlineOffering'
  | 'onlineFood'
  | 'onlineOrdering'
  | 'onlineSessions'
  | 'pricing';

/** Where a group of attributes, or an inclusion practice, is offered. */
export interface ListingOfferScope {
  /** The kinds of listing it is offered to. */
  kinds: readonly ListingKind[];
  /** The categories it needs one of, or `null` for every category. */
  categories: readonly string[] | null;
}

export interface ListingAttributeGroup extends ListingOfferScope {
  id: ListingAttributeGroupId;
  /** Slugs in display order. A slug may sit in several groups. */
  attributes: readonly string[];
}

const IN_PERSON_KINDS: readonly ListingKind[] = ['place', 'mobile'];
const ONLINE_KINDS: readonly ListingKind[] = ['online'];
const EVERY_KIND: readonly ListingKind[] = ['place', 'mobile', 'online'];

/** The contract table, in its order. The owner UI renders `pricing` last for every kind. */
export const LISTING_ATTRIBUTE_GROUPS: readonly ListingAttributeGroup[] = [
  {
    id: 'around',
    kinds: IN_PERSON_KINDS,
    categories: null,
    attributes: [
      'terrace',
      'wifi',
      'laptop-friendly',
      'kid-friendly',
      'dog-friendly',
      'solo-friendly',
      'space-for-hire',
      'takeaway',
      'delivery',
      'hosts-events',
      'workshops',
      'classes',
    ],
  },
  {
    id: 'food',
    kinds: IN_PERSON_KINDS,
    categories: ['food'],
    attributes: [
      'vegan-options',
      'vegetarian-options',
      'gluten-free-options',
      'halal',
      'alcohol-free-drinks',
      'brunch',
      'kitchen-open-late',
    ],
  },
  {
    id: 'nightlife',
    kinds: IN_PERSON_KINDS,
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
  {
    id: 'culture',
    kinds: IN_PERSON_KINDS,
    categories: ['culture'],
    attributes: [
      'exhibitions',
      'readings-and-talks',
      'screenings',
      'english-subtitles',
      'lgbtq-section',
      'book-club',
      'second-hand',
    ],
  },
  {
    id: 'space',
    kinds: IN_PERSON_KINDS,
    categories: ['space'],
    attributes: [
      'support-groups',
      'kitchen-access',
      'projector-and-sound',
      'quiet-room',
      'open-to-non-members',
    ],
  },
  {
    id: 'grooming',
    kinds: IN_PERSON_KINDS,
    categories: ['grooming'],
    attributes: [
      'priced-by-service',
      'curly-textured-hair',
      'colour-specialist',
      'shaves-and-beards',
      'facial-hair-removal',
      'makeup',
      'private-room',
    ],
  },
  {
    id: 'fitness',
    kinds: IN_PERSON_KINDS,
    categories: ['fitness'],
    attributes: [
      'drop-in-classes',
      'day-passes',
      'class-packs',
      'memberships',
      'beginner-sessions',
      'trans-nonbinary-sessions',
      'private-changing',
      'personal-training',
    ],
  },
  {
    id: 'health',
    kinds: IN_PERSON_KINDS,
    categories: ['health'],
    attributes: [
      'takes-insurance',
      'online-consultations',
      'home-visits',
      'same-week-appointments',
      'sexual-health-prep',
      'trans-care-experience',
    ],
  },
  {
    id: 'design',
    kinds: IN_PERSON_KINDS,
    categories: ['design'],
    attributes: [
      'made-to-order',
      'custom-commissions',
      'local-makers',
      'second-hand',
      'repairs',
      'gift-wrapping',
    ],
  },
  {
    id: 'tech',
    kinds: IN_PERSON_KINDS,
    categories: ['tech'],
    attributes: [
      'repairs',
      'refurbished',
      'data-recovery',
      'beginner-help',
      'trade-ins',
    ],
  },
  {
    id: 'tours',
    kinds: IN_PERSON_KINDS,
    categories: ['tours'],
    attributes: [
      'queer-history',
      'walking-tours',
      'private-tours',
      'small-groups',
      'step-free-route',
    ],
  },
  {
    id: 'home-services',
    kinds: IN_PERSON_KINDS,
    categories: ['home-services'],
    attributes: [
      'free-quotes',
      'same-day',
      'weekend-visits',
      'insured',
      'small-jobs',
    ],
  },
  {
    id: 'onlineOffering',
    kinds: ONLINE_KINDS,
    categories: null,
    attributes: [
      'workshops',
      'classes',
      'readings-and-talks',
      'hosts-events',
      'support-groups',
      'by-appointment',
      'memberships',
      'beginner-friendly',
      'good-for-gifts',
    ],
  },
  {
    id: 'onlineFood',
    kinds: ONLINE_KINDS,
    categories: ['food'],
    attributes: [
      'vegan-options',
      'vegetarian-options',
      'gluten-free-options',
      'alcohol-free-drinks',
    ],
  },
  {
    id: 'onlineOrdering',
    kinds: ONLINE_KINDS,
    categories: null,
    attributes: ['made-to-order', 'custom-commissions', 'gift-cards'],
  },
  {
    id: 'onlineSessions',
    kinds: ONLINE_KINDS,
    categories: null,
    attributes: ['free-first-call'],
  },
  {
    id: 'pricing',
    kinds: EVERY_KIND,
    categories: null,
    attributes: ['sliding-scale', 'pay-what-you-can', 'student-discount'],
  },
];

/** Facts about a fixed venue. Never offered to an out and about (`mobile`) listing. */
export const PREMISES_ONLY_ATTRIBUTE_SLUGS = [
  'terrace',
  'wifi',
  'laptop-friendly',
  'space-for-hire',
  'kitchen-open-late',
  'dancefloor',
  'quiet-corner',
  'smoking-area',
  'coat-check',
  'kitchen-access',
  'projector-and-sound',
  'quiet-room',
  'private-room',
  'private-changing',
] as const;

/**
 * Health facts a member may need to know and should never be found by.
 * Shown on the detail page; never filterable (`attr` answers 400) and never a
 * highlight (400), so no card or grid count names them.
 */
export const SENSITIVE_ATTRIBUTE_SLUGS = [
  'sexual-health-prep',
  'trans-care-experience',
] as const;

/** Every slug, each once, in group order. */
export const LISTING_ATTRIBUTE_SLUGS: readonly string[] = [
  ...new Set(LISTING_ATTRIBUTE_GROUPS.flatMap((group) => group.attributes)),
];

const ATTRIBUTE_SLUG_SET: ReadonlySet<string> = new Set(
  LISTING_ATTRIBUTE_SLUGS,
);
const PREMISES_ONLY_SLUG_SET: ReadonlySet<string> = new Set(
  PREMISES_ONLY_ATTRIBUTE_SLUGS,
);
const SENSITIVE_SLUG_SET: ReadonlySet<string> = new Set(
  SENSITIVE_ATTRIBUTE_SLUGS,
);

/** What the directory's `attr` filter accepts: every slug that is not sensitive. */
export const FILTERABLE_LISTING_ATTRIBUTE_SLUGS: readonly string[] =
  LISTING_ATTRIBUTE_SLUGS.filter((slug) => !SENSITIVE_SLUG_SET.has(slug));

export const MAX_LISTING_ATTRIBUTES = 40;
export const MAX_LISTING_HIGHLIGHTS = 3;
export const MAX_LISTING_ATTRIBUTE_SLUG_LENGTH = 40;

/** How people get in. `null` on the row is "not said". */
export const LISTING_ENTRY_MODES = [
  'walkIn',
  'bookingRecommended',
  'appointmentOnly',
  'membersOnly',
] as const;
export type ListingEntryMode = (typeof LISTING_ENTRY_MODES)[number];

/** The entry charge, kept only on a `nightlife` or `culture` listing. */
export const LISTING_COVER_POLICIES = [
  'free',
  'freeBefore',
  'cover',
  'ticketed',
] as const;
export type ListingCoverPolicy = (typeof LISTING_COVER_POLICIES)[number];
export const COVER_POLICY_CATEGORY_SLUGS = ['nightlife', 'culture'] as const;
/** `coverFreeBefore`: 24-hour `HH:MM`. */
export const COVER_FREE_BEFORE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Ways to pay in person. Online listings keep `onlineDetails.payments`. */
export const LISTING_PAYMENT_METHODS = [
  'card',
  'mbway',
  'multibanco',
  'cash',
] as const;
export type ListingPaymentMethod = (typeof LISTING_PAYMENT_METHODS)[number];

/** Practices above the affirming baseline a member can check on a visit. */
export const LISTING_INCLUSION_PRACTICES = [
  'chosen-name',
  'safer-space-policy',
  'named-contact',
  'harm-reduction',
] as const;
export type ListingInclusionPractice =
  (typeof LISTING_INCLUSION_PRACTICES)[number];

/** The practice that needs `saferSpacePolicyUrl`. */
export const SAFER_SPACE_POLICY_PRACTICE: ListingInclusionPractice =
  'safer-space-policy';

export interface ListingInclusionPracticeScope extends ListingOfferScope {
  slug: ListingInclusionPractice;
}

export const LISTING_INCLUSION_PRACTICE_SCOPES: readonly ListingInclusionPracticeScope[] =
  [
    { slug: 'chosen-name', kinds: EVERY_KIND, categories: null },
    { slug: 'safer-space-policy', kinds: EVERY_KIND, categories: null },
    { slug: 'named-contact', kinds: IN_PERSON_KINDS, categories: null },
    {
      slug: 'harm-reduction',
      kinds: IN_PERSON_KINDS,
      categories: ['nightlife'],
    },
  ];

/** The `safer_space_policy_url` column width, the `https://` prefix included. */
export const MAX_SAFER_SPACE_POLICY_URL_LENGTH = 300;

/** Languages a listing's people speak. Anything else goes in `langsOther`. */
export const LISTING_LANGUAGE_CODES = [
  'pt',
  'pt-BR',
  'en',
  'es',
  'fr',
  'it',
  'de',
  'uk',
  'ru',
  'zh',
  'hi',
  'ne',
  'bn',
  'ar',
  'kea',
  'lgp',
  'ils',
] as const;
export type ListingLanguageCode = (typeof LISTING_LANGUAGE_CODES)[number];

/** The chips the owner UI shows before "More languages". */
export const COMMON_LISTING_LANGUAGE_CODES = [
  'pt',
  'pt-BR',
  'en',
  'es',
  'fr',
] as const satisfies readonly ListingLanguageCode[];

/** Each language in its own name, for the few server-built strings that print one. */
export const LISTING_LANGUAGE_NAMES: Readonly<
  Record<ListingLanguageCode, string>
> = {
  pt: 'Português',
  'pt-BR': 'Português (Brasil)',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  de: 'Deutsch',
  uk: 'Українська',
  ru: 'Русский',
  zh: '中文',
  hi: 'हिन्दी',
  ne: 'नेपाली',
  bn: 'বাংলা',
  ar: 'العربية',
  kea: 'Kriolu (Cabo Verde)',
  lgp: 'LGP (língua gestual)',
  ils: 'International Sign',
};

/** A `Map`, so a stored value such as `constructor` never reads an `Object.prototype` member. */
const LANGUAGE_NAME_BY_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(LISTING_LANGUAGE_NAMES),
);

export const MAX_LISTING_LANGS_OTHER_LENGTH = 80;

/**
 * The language names an old cached frontend still sends in `langs`, each with
 * the code it means. "Other" is dropped by `legacyLanguageNamesToCodes`.
 *
 * @deprecated For one release only: remove with the tags/good_for column drop.
 */
export const LEGACY_LANGUAGE_NAME_CODES: Readonly<
  Record<string, ListingLanguageCode>
> = {
  Português: 'pt',
  'Português (Brasil)': 'pt-BR',
  English: 'en',
  Español: 'es',
  Français: 'fr',
  'LGP (sign)': 'lgp',
};

const LEGACY_OTHER_LANGUAGE_NAME = 'other';

/** Keyed by the NFC, lower-cased name, as a `Map` so `constructor` reads nothing. */
const LEGACY_LANGUAGE_CODE_BY_FOLDED_NAME: ReadonlyMap<
  string,
  ListingLanguageCode
> = new Map(
  Object.entries(LEGACY_LANGUAGE_NAME_CODES).map(([name, code]) => [
    foldLegacyLanguageName(name),
    code,
  ]),
);

function foldLegacyLanguageName(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/**
 * Maps the six legacy language names in a `langs` body to their codes, drops
 * "Other" and dedupes, keeping the first position of each value. Names match
 * trimmed and case-insensitively after NFC; every other string, and every
 * non-string entry, passes through as sent for the validators to judge. A
 * value that is not an array is returned untouched.
 *
 * @deprecated For one release only: remove with the tags/good_for column drop.
 */
export function legacyLanguageNamesToCodes(values: unknown): unknown {
  if (!Array.isArray(values)) return values;
  const mapped: unknown[] = [];
  for (const value of values as unknown[]) {
    if (typeof value !== 'string') {
      mapped.push(value);
      continue;
    }
    const foldedName = foldLegacyLanguageName(value);
    if (foldedName === LEGACY_OTHER_LANGUAGE_NAME) continue;
    mapped.push(LEGACY_LANGUAGE_CODE_BY_FOLDED_NAME.get(foldedName) ?? value);
  }
  return [...new Set(mapped)];
}

export function isListingAttributeSlug(slug: string): boolean {
  return ATTRIBUTE_SLUG_SET.has(slug);
}

export function isSensitiveListingAttribute(slug: string): boolean {
  return SENSITIVE_SLUG_SET.has(slug);
}

export function isPremisesOnlyListingAttribute(slug: string): boolean {
  return PREMISES_ONLY_SLUG_SET.has(slug);
}

/** The offer rule: the kind is in `kinds`, and `categories` is null or the listing has one of them. */
export function isOfferedByScope(
  scope: ListingOfferScope,
  kind: ListingKind,
  categories: readonly string[],
): boolean {
  return (
    scope.kinds.includes(kind) &&
    (scope.categories === null ||
      scope.categories.some((category) => categories.includes(category)))
  );
}

/** Every slug offered to a listing of this kind in these categories. */
export function offeredListingAttributeSlugs(
  kind: ListingKind,
  categories: readonly string[],
): ReadonlySet<string> {
  const offeredSlugs = new Set<string>();
  for (const group of LISTING_ATTRIBUTE_GROUPS) {
    if (!isOfferedByScope(group, kind, categories)) continue;
    for (const slug of group.attributes) {
      if (kind === 'mobile' && PREMISES_ONLY_SLUG_SET.has(slug)) continue;
      offeredSlugs.add(slug);
    }
  }
  return offeredSlugs;
}

export function isListingAttributeOffered(
  slug: string,
  kind: ListingKind,
  categories: readonly string[],
): boolean {
  return offeredListingAttributeSlugs(kind, categories).has(slug);
}

export function isListingInclusionPracticeOffered(
  practice: string,
  kind: ListingKind,
  categories: readonly string[],
): boolean {
  const scope = LISTING_INCLUSION_PRACTICE_SCOPES.find(
    (entry) => entry.slug === practice,
  );
  return scope !== undefined && isOfferedByScope(scope, kind, categories);
}

/**
 * A raw slug list as the write rules compare it: string entries only,
 * trimmed and lowercased, blanks dropped, each slug once in first-seen order.
 */
export function canonicalListingSlugs(
  raw: readonly unknown[] | null | undefined,
): string[] {
  const slugs: string[] = [];
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue;
    const slug = entry.trim().toLowerCase();
    if (slug !== '' && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

export interface NormalizedListingAttributes {
  /** The slugs to store, in the order sent. */
  attributes: string[];
  /** Requested slugs that are neither in the vocabulary nor already on the listing. */
  unknown: string[];
  /** Known slugs this listing is not offered and does not already carry. */
  notOffered: string[];
}

/**
 * Resolves a requested attribute list against the vocabulary and the offer.
 *
 * A slug the listing already carries (`existing`) stays valid whatever the
 * vocabulary and the offer say, so an owner whose categories changed can
 * still save an unrelated edit, and the owner UI can list the slug under "No
 * longer fits your categories" for removal. The same rule
 * `normalizeListingTags` applied to the tags this replaces.
 *
 * Pure: the caller decides what to do with `unknown` and `notOffered`.
 */
export function normalizeListingAttributes(
  requested: readonly unknown[] | null | undefined,
  existing: readonly unknown[] | null | undefined,
  kind: ListingKind,
  categories: readonly string[],
): NormalizedListingAttributes {
  const storedSlugs = new Set(canonicalListingSlugs(existing));
  const offeredSlugs = offeredListingAttributeSlugs(kind, categories);
  const normalized: NormalizedListingAttributes = {
    attributes: [],
    unknown: [],
    notOffered: [],
  };
  for (const slug of canonicalListingSlugs(requested)) {
    if (storedSlugs.has(slug) || offeredSlugs.has(slug)) {
      normalized.attributes.push(slug);
    } else if (!ATTRIBUTE_SLUG_SET.has(slug)) {
      normalized.unknown.push(slug);
    } else {
      normalized.notOffered.push(slug);
    }
  }
  return normalized;
}

export interface NormalizedListingInclusionPractices {
  /** The practices to store, in vocabulary order. */
  inclusionPractices: ListingInclusionPractice[];
  /** Requested practices outside their scope that the listing does not already carry. */
  notOffered: string[];
}

/** The practice twin of `normalizeListingAttributes`: stored practices stay valid. */
export function normalizeListingInclusionPractices(
  requested: readonly unknown[] | null | undefined,
  existing: readonly unknown[] | null | undefined,
  kind: ListingKind,
  categories: readonly string[],
): NormalizedListingInclusionPractices {
  const storedSlugs = new Set(canonicalListingSlugs(existing));
  const keptSlugs = new Set<string>();
  const notOffered: string[] = [];
  for (const slug of canonicalListingSlugs(requested)) {
    if (
      storedSlugs.has(slug) ||
      isListingInclusionPracticeOffered(slug, kind, categories)
    ) {
      keptSlugs.add(slug);
    } else {
      notOffered.push(slug);
    }
  }
  return {
    inclusionPractices: LISTING_INCLUSION_PRACTICES.filter((practice) =>
      keptSlugs.has(practice),
    ),
    notOffered,
  };
}

/** Known ways to pay, each once, in vocabulary order. Anything else drops out. */
export function normalizeListingPayments(
  values: readonly unknown[] | null | undefined,
): ListingPaymentMethod[] {
  const wantedMethods = new Set(canonicalListingSlugs(values));
  return LISTING_PAYMENT_METHODS.filter((method) => wantedMethods.has(method));
}

/**
 * The languages as words: each code in its own name (an unknown value as
 * written), then `langsOther` trimmed when it holds anything.
 */
export function listingLanguageLabels(
  langs: readonly string[] | null | undefined,
  langsOther: string | null | undefined,
): string[] {
  const labels = (langs ?? []).map(
    (code) => LANGUAGE_NAME_BY_CODE.get(code) ?? code,
  );
  const otherLanguages = (langsOther ?? '').trim();
  return otherLanguages === '' ? labels : [...labels, otherLanguages];
}

/** `GET /directory/attributes`. */
export interface ListingAttributeVocabularyDTO {
  groups: {
    id: ListingAttributeGroupId;
    kinds: ListingKind[];
    categories: string[] | null;
    attributes: string[];
  }[];
  premisesOnly: string[];
  sensitive: string[];
  inclusionPractices: {
    slug: ListingInclusionPractice;
    kinds: ListingKind[];
    categories: string[] | null;
  }[];
  languages: string[];
  commonLanguages: string[];
}

/** The vocabulary as served. Every array is a fresh copy, so no caller can mutate a constant. */
export function toListingAttributeVocabularyDTO(): ListingAttributeVocabularyDTO {
  return {
    groups: LISTING_ATTRIBUTE_GROUPS.map((group) => ({
      id: group.id,
      kinds: [...group.kinds],
      categories: group.categories === null ? null : [...group.categories],
      attributes: [...group.attributes],
    })),
    premisesOnly: [...PREMISES_ONLY_ATTRIBUTE_SLUGS],
    sensitive: [...SENSITIVE_ATTRIBUTE_SLUGS],
    inclusionPractices: LISTING_INCLUSION_PRACTICE_SCOPES.map((scope) => ({
      slug: scope.slug,
      kinds: [...scope.kinds],
      categories: scope.categories === null ? null : [...scope.categories],
    })),
    languages: [...LISTING_LANGUAGE_CODES],
    commonLanguages: [...COMMON_LISTING_LANGUAGE_CODES],
  };
}
