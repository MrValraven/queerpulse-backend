/**
 * The ownership-identity tags a listing's OWNER may declare about who owns and
 * runs the business: women (cis and trans), trans people, non-binary people.
 * Stored on `Listing.ownedBy`, written by `CreateListingDto` /
 * `UpdateListingDto`, and filtered on by the directory's `owned=` query, so all
 * three read this one list.
 *
 * SELF-DECLARED, NEVER VERIFIED. Unlike the queer-owned badge there is no
 * moderator confirmation behind any of these, so no surface may present one as
 * checked.
 *
 * OWNER-PERSONAL. Each tag discloses the gender identity of the person who owns
 * the business, which is an outing risk, so `ownedBy` is one of
 * `OWNER_PERSONAL_LISTING_FIELDS`: only the owner writes it, a co-manager
 * neither sees nor sends it, a suggestion and a staff-authored listing never
 * store it, and it leaves with the owner on a handover.
 *
 * The ORDER here is the canonical order: stored values and the parsed query
 * are both sorted into it, so the same set always reads the same way.
 */
export const LISTING_OWNED_BY_VALUES = ['women', 'trans', 'nonbinary'] as const;

export type ListingOwnedBy = (typeof LISTING_OWNED_BY_VALUES)[number];

/** True for one of `LISTING_OWNED_BY_VALUES`. */
export function isListingOwnedBy(value: unknown): value is ListingOwnedBy {
  return (LISTING_OWNED_BY_VALUES as readonly unknown[]).includes(value);
}

/**
 * The stored form of a set of tags: known values only, each once, in canonical
 * order. `null`/`undefined` (a legacy row, an omitted field) reads as `[]`, so
 * every response carries a real array. Returns a fresh array every time.
 */
export function normalizeListingOwnedBy(
  values: readonly unknown[] | null | undefined,
): ListingOwnedBy[] {
  const present = new Set((values ?? []).filter(isListingOwnedBy));
  return LISTING_OWNED_BY_VALUES.filter((value) => present.has(value));
}
