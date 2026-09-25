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
 * and the price tier belongs in `price`. None of those are tags.
 *
 * Served as-is by `GET /directory/tags` so the frontend picker and this
 * validation read one list.
 */
export type ListingTagGroupId =
  'visiting' | 'happening' | 'foodDrink' | 'pricing' | 'languages';

export interface ListingTagGroup {
  id: ListingTagGroupId;
  tags: readonly string[];
}

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
  },
  {
    id: 'pricing',
    tags: [
      'Gender-neutral pricing',
      'Sliding scale',
      'Pay what you can',
      'Student discount',
    ],
  },
  {
    id: 'languages',
    tags: [
      'Portuguese spoken',
      'English spoken',
      'Spanish spoken',
      'French spoken',
      'Portuguese Sign Language',
    ],
  },
];

/** Every tag in the vocabulary, in group order. */
export const LISTING_TAG_OPTIONS: readonly string[] =
  LISTING_TAG_GROUPS.flatMap((group) => group.tags);

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
