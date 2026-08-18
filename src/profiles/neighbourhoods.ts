/**
 * The "where they're based" vocabulary, server-side. Mirrors `NEIGHBOURHOODS`
 * in the frontend's `memberDirectoryFilter.data.ts` (minus `ALL_OF_LISBON`,
 * which is FE-only chrome meaning "no hood filter" and is stripped before the
 * request reaches the wire — see `MemberDirectoryFilterPage`'s
 * `matchesFilters`).
 *
 * `profiles.location` is free text ("Anjos, Lisboa", "Lisbon"), not a closed
 * enum, so a neighbourhood "match" is a substring test against the member's
 * own words rather than an equality check. The same `matchHood` function
 * backs both the `?hoods=` filter and the value returned on the member card
 * (`MemberCard.hood`), so filtering and display can never drift apart.
 */
export const NEIGHBOURHOODS = [
  'Anjos',
  'Mouraria',
  'Graça',
  'Alfama',
  'Bairro Alto',
  'Marvila',
  'Príncipe Real',
] as const;

const NEIGHBOURHOOD_SET: ReadonlySet<string> = new Set(NEIGHBOURHOODS);

export function isNeighbourhood(value: string): boolean {
  return NEIGHBOURHOOD_SET.has(value);
}

export function knownNeighbourhoods(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isNeighbourhood))];
}

/** The first neighbourhood whose name appears in a member's free-text
 *  location, or `null` if none match (unset location, or a location outside
 *  the curated list). Case-sensitive on purpose — the proper nouns are
 *  untranslated (i18n sweep §6) and members write them consistently. */
export function matchNeighbourhood(location: string | null): string | null {
  if (!location) return null;
  return NEIGHBOURHOODS.find((hood) => location.includes(hood)) ?? null;
}
