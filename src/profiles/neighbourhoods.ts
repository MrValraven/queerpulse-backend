import { foldSearchText } from '../search/search-text';

/**
 * The "where they're based" vocabulary, server-side. Mirrors
 * `LISBON_NEIGHBOURHOODS` in the frontend's
 * `src/shared/geo/lisbonNeighbourhoods.ts` — the list the profile editor's
 * neighbourhood select offers — minus `ALL_OF_LISBON`, which is FE-only
 * chrome meaning "no hood filter" and is stripped before the request reaches
 * the wire (see `useMemberDirectoryQuery`). Keep the two in step: a name a
 * member can pick that is missing here is a member no filter can find.
 *
 * It carries two vocabularies on purpose. The 24 official freguesias
 * (parishes) are the taxonomy housing and the map already use; the nine
 * informal bairros before them are what people actually say. Members write
 * "Príncipe Real", never "Santo António".
 *
 * `profiles.location` is free text ("Anjos, Lisboa", "Lisbon"), not a closed
 * enum, so a neighbourhood "match" is a substring test against the member's
 * own words rather than an equality check. The same `matchNeighbourhood`
 * function backs both the `?hoods=` filter and the value returned on the
 * member card (`MemberCard.hood`), so filtering and display can never drift
 * apart.
 */
export const NEIGHBOURHOODS = [
  // ── Informal bairros ──
  'Alfama',
  'Anjos',
  'Bairro Alto',
  'Cais do Sodré',
  'Graça',
  'Intendente',
  'Mouraria',
  'Príncipe Real',
  'Santos',
  // ── The 24 official freguesias ──
  'Ajuda',
  'Alcântara',
  'Alvalade',
  'Areeiro',
  'Arroios',
  'Avenidas Novas',
  'Beato',
  'Belém',
  'Benfica',
  'Campo de Ourique',
  'Campolide',
  'Carnide',
  'Estrela',
  'Lumiar',
  'Marvila',
  'Misericórdia',
  'Olivais',
  'Parque das Nações',
  'Penha de França',
  'Santa Clara',
  'Santa Maria Maior',
  'Santo António',
  'São Domingos de Benfica',
  'São Vicente',
] as const;

const NEIGHBOURHOOD_SET: ReadonlySet<string> = new Set(NEIGHBOURHOODS);

/** Match candidates, longest name first. Order matters because the match below
 *  is a substring test and some names contain others: "São Domingos de
 *  Benfica" must be tried before "Benfica", or every member in the former is
 *  reported as living in the latter. */
const BY_LENGTH_DESC: readonly string[] = [...NEIGHBOURHOODS].sort(
  (first, second) => second.length - first.length,
);

export function isNeighbourhood(value: string): boolean {
  return NEIGHBOURHOOD_SET.has(value);
}

export function knownNeighbourhoods(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isNeighbourhood))];
}

/** The same candidates, each paired with its folded spelling. Folding is one
 *  character in, one character out, so the longest-first order still holds. */
const FOLDED_BY_LENGTH_DESC: readonly (readonly [string, string])[] =
  BY_LENGTH_DESC.map((hood) => [hood, foldSearchText(hood)] as const);

/** The most specific neighbourhood whose name appears in a member's free-text
 *  location, or `null` if none match (unset location, or a location outside
 *  the list: someone in Porto, say). Case- and accent-folded with
 *  `foldSearchText`, the JS twin of the fold the member directory's `?hoods=`
 *  SQL filter applies, so "principe real" and "Principe Real" both resolve to
 *  the canonical `Príncipe Real` the filter would sort them into. */
export function matchNeighbourhood(location: string | null): string | null {
  if (!location) return null;
  const foldedLocation = foldSearchText(location);
  const match = FOLDED_BY_LENGTH_DESC.find(([, foldedHood]) =>
    foldedLocation.includes(foldedHood),
  );
  return match ? match[0] : null;
}
