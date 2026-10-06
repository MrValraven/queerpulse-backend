import { BadRequestException } from '@nestjs/common';

/**
 * The curated vocabulary a listing's `tags` column is picked from. Owners
 * choose from these groups in the "list your business" wizard and the listing
 * editor; there is no free-text entry.
 *
 * Stored values are these English strings, verbatim. The frontend translates
 * them for display, keyed by the string, so renaming one here is a data change
 * that needs a migration and a matching catalog entry on the frontend.
 *
 * What stays out on purpose: accessibility claims belong in `accessibility`
 * (structured answers that can also say no), atmosphere belongs in `goodFor`,
 * the price tier belongs in `price`, and spoken languages belong in `langs`.
 * None of those are tags.
 *
 * Each group carries two lists. `tags` are offered to listings with a physical
 * place, and `onlineTags` are offered to online-only listings
 * (`listings.online === true`), so an online shop sees shipping and payment
 * tags while a bar sees Terrace and DJ nights. Either list may be empty, and a
 * tag that fits both kinds of listing appears in both lists.
 *
 * Validation reads the union of both lists for every listing, whatever its
 * `online` flag. An owner who flips the online toggle keeps the tags picked
 * earlier, and the frontend shows them as removable chips, so a save after
 * the flip must still accept them.
 *
 * Served as-is by `GET /directory/tags` so the frontend picker and this
 * validation read one list.
 */
export type ListingTagGroupId =
  | 'visiting'
  | 'happening'
  | 'foodDrink'
  | 'pricing'
  | 'ordering'
  | 'payment'
  | 'sessions';

export interface ListingTagGroup {
  id: ListingTagGroupId;
  /** Tags offered to listings with a physical place. May be empty. */
  tags: readonly string[];
  /** Tags offered to online-only listings. May be empty. */
  onlineTags: readonly string[];
}

const PRICING_TAGS: readonly string[] = [
  'Gender-neutral pricing',
  'Sliding scale',
  'Pay what you can',
  'Student discount',
];

export const LISTING_TAG_GROUPS: readonly ListingTagGroup[] = [
  {
    id: 'visiting',
    tags: [
      'By appointment',
      'Booking recommended',
      'Members only',
      'Free entry',
      'Day passes',
      'Memberships',
      'Class packs',
    ],
    onlineTags: ['By appointment', 'Memberships'],
  },
  {
    id: 'happening',
    tags: [
      'Workshops',
      'Classes',
      'Live music',
      'DJ nights',
      'Drag shows',
      'Exhibitions',
      'Readings and talks',
      'Community events',
      'Support groups',
      'Space for hire',
    ],
    onlineTags: [
      'Workshops',
      'Classes',
      'Readings and talks',
      'Community events',
      'Support groups',
    ],
  },
  {
    id: 'foodDrink',
    tags: [
      'Vegan options',
      'Vegetarian options',
      'Gluten-free options',
      'Alcohol-free options',
      'Terrace',
      'Late opening',
    ],
    onlineTags: [
      'Vegan options',
      'Vegetarian options',
      'Gluten-free options',
      'Alcohol-free options',
    ],
  },
  {
    id: 'pricing',
    tags: PRICING_TAGS,
    onlineTags: PRICING_TAGS,
  },
  {
    id: 'ordering',
    tags: [],
    onlineTags: [
      'Ships to Portugal',
      'Ships across the EU',
      'Ships worldwide',
      'Pick-up in Lisbon',
      'Made to order',
      'Custom commissions',
      'Digital downloads',
      'Gift cards',
    ],
  },
  {
    id: 'payment',
    tags: [],
    onlineTags: ['MB WAY', 'Multibanco', 'PayPal'],
  },
  {
    id: 'sessions',
    tags: [],
    onlineTags: ['Video sessions', 'Phone sessions', 'Free first call'],
  },
];

/**
 * Every tag in the vocabulary, place and online alike, each once, in group
 * order. Within a group the place tags come first, then any online tag the
 * place list lacks.
 */
export const LISTING_TAG_OPTIONS: readonly string[] = [
  ...new Set(
    LISTING_TAG_GROUPS.flatMap((group) => [...group.tags, ...group.onlineTags]),
  ),
];

/** Lowercased tag to its canonical spelling, for case-insensitive matching. */
const CANONICAL_TAG_BY_LOWERCASE = new Map<string, string>(
  LISTING_TAG_OPTIONS.map((tag) => [tag.toLowerCase(), tag]),
);

export interface NormalizedListingTags {
  /** The tags to store: canonical spellings, trimmed, deduplicated. */
  tags: string[];
  /** Requested tags that are neither in the vocabulary nor already on the listing. */
  unknown: string[];
}

/**
 * Resolves a requested tag list against the vocabulary.
 *
 * Each entry is trimmed and matched case-insensitively. A vocabulary match is
 * stored in its canonical spelling. A tag outside the vocabulary is allowed
 * only when the listing already carries it (`existing`), in the listing's own
 * spelling, so a listing saved before the vocabulary existed can still be
 * edited without first deleting its older tags. Anything else lands in
 * `unknown`. Blank entries are dropped, and a repeat (compared
 * case-insensitively) keeps its first occurrence.
 *
 * Pure: the caller decides what to do with `unknown`.
 */
export function normalizeListingTags(
  requested: string[],
  existing: readonly string[],
): NormalizedListingTags {
  const existingSpellingByLowercase = new Map<string, string>();
  for (const existingTag of existing) {
    const trimmedExistingTag = existingTag.trim();
    const lowercaseKey = trimmedExistingTag.toLowerCase();
    if (
      trimmedExistingTag !== '' &&
      !existingSpellingByLowercase.has(lowercaseKey)
    ) {
      existingSpellingByLowercase.set(lowercaseKey, existingTag);
    }
  }

  const tags: string[] = [];
  const unknown: string[] = [];
  const seenLowercaseKeys = new Set<string>();
  for (const requestedTag of requested) {
    const trimmedTag = requestedTag.trim();
    if (trimmedTag === '') continue;
    const lowercaseKey = trimmedTag.toLowerCase();
    if (seenLowercaseKeys.has(lowercaseKey)) continue;
    seenLowercaseKeys.add(lowercaseKey);

    const resolvedTag =
      CANONICAL_TAG_BY_LOWERCASE.get(lowercaseKey) ??
      existingSpellingByLowercase.get(lowercaseKey);
    if (resolvedTag === undefined) {
      unknown.push(trimmedTag);
    } else {
      tags.push(resolvedTag);
    }
  }
  return { tags, unknown };
}

/**
 * `normalizeListingTags` for a write path: returns the tags to store, or
 * throws a 400 naming every tag the vocabulary does not know.
 */
export function resolveListingTagsOrThrow(
  requested: string[],
  existing: readonly string[],
): string[] {
  const { tags, unknown } = normalizeListingTags(requested, existing);
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown listing tags: ${unknown.map((tag) => `"${tag}"`).join(', ')}. ` +
        'Pick tags from GET /directory/tags.',
    );
  }
  return tags;
}
