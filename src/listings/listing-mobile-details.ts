/**
 * The "Out and about" facts of a listing with no fixed premises
 * (`mobile === true`): a walking tour, a mobile hairdresser, a photographer, a
 * moving company. Stored as one jsonb column (`listings.mobile_details`) and
 * normalised on every read and write, the way `onlineDetails` is, so a row
 * written before the column existed (`'{}'`) reads as the complete default.
 *
 * Both vocabularies are mirrored string for string by the frontend; see the
 * wire contract `QUEERPULSE-NO-FIXED-PREMISES-CONTRACT-2026-10-08.md`. Names
 * are stored precomposed (Unicode NFC), the form `freguesias.data.ts` uses,
 * and every input is NFC-normalised and trimmed before it is compared.
 */

/** The 24 Lisbon parishes, spelled as `properties.name` in the frontend's `freguesias.data.ts`. */
export const LISBON_PARISH_NAMES = [
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

export type LisbonParishName = (typeof LISBON_PARISH_NAMES)[number];

/** The municipalities around Lisbon a mobile business may also travel to. */
export const NEARBY_MUNICIPALITIES = [
  'Almada',
  'Amadora',
  'Cascais',
  'Loures',
  'Odivelas',
  'Oeiras',
  'Seixal',
  'Sintra',
] as const;

export type NearbyMunicipality = (typeof NEARBY_MUNICIPALITIES)[number];

/**
 * The three kinds of listing. New code asks `listingKindOf` and never reads
 * the `online` and `mobile` flags directly.
 */
export type ListingKind = 'place' | 'online' | 'mobile';

export interface ListingMobileDetails {
  /** "All of Lisbon". When true, `parishes` is empty. */
  allOfCity: boolean;
  /** "Some parishes": names from `LISBON_PARISH_NAMES`, each once, in list order. */
  parishes: string[];
  /** "Also travels to": names from `NEARBY_MUNICIPALITIES`, each once, in list order. */
  alsoTravelsTo: string[];
  /** "By appointment only": the listing keeps no opening hours. */
  byAppointment: boolean;
}

/** The flags `listingKindOf` reads, off a row or a request body. */
export interface ListingKindSource {
  online?: boolean | null;
  mobile?: boolean | null;
}

/** The flags and the pin a reader needs to decide whether a listing has a meeting point. */
export interface ListingMeetingPointSource extends ListingKindSource {
  latitude?: number | null;
  longitude?: number | null;
}

/** The names a raw `mobileDetails` carries that neither vocabulary knows, after NFC. */
export interface UnknownMobileAreaNames {
  parishes: string[];
  municipalities: string[];
}

/** A fresh default value. A function so no caller shares one mutable object. */
export function emptyListingMobileDetails(): ListingMobileDetails {
  return {
    allOfCity: true,
    parishes: [],
    alsoTravelsTo: [],
    byAppointment: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A raw list's string entries, NFC-normalised and trimmed; anything else reads as no entries. */
function normalizedNameEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.normalize('NFC').trim());
}

/** The vocabulary names a raw list carries, each once, in vocabulary order. */
function canonicalNames(vocabulary: readonly string[], raw: unknown): string[] {
  const wantedNames = new Set(normalizedNameEntries(raw));
  return vocabulary.filter((name) => wantedNames.has(name));
}

/**
 * Any stored or submitted value, read as a complete `ListingMobileDetails`:
 * unknown names drop out, lists come back once each in vocabulary order, and
 * `allOfCity` (true unless the value says `false`) empties `parishes`.
 * Idempotent, so it runs on reads and writes alike. The write path refuses
 * unknown names before it gets here (`findUnknownMobileAreaNames`).
 */
export function normalizeListingMobileDetails(
  raw: unknown,
): ListingMobileDetails {
  const source = asRecord(raw) ?? {};
  const allOfCity = source.allOfCity !== false;
  return {
    allOfCity,
    parishes: allOfCity
      ? []
      : canonicalNames(LISBON_PARISH_NAMES, source.parishes),
    alsoTravelsTo: canonicalNames(NEARBY_MUNICIPALITIES, source.alsoTravelsTo),
    byAppointment: source.byAppointment === true,
  };
}

/** Every parish and municipality name a raw `mobileDetails` carries outside the vocabularies. */
export function findUnknownMobileAreaNames(
  raw: unknown,
): UnknownMobileAreaNames {
  const source = asRecord(raw) ?? {};
  const parishNames = new Set<string>(LISBON_PARISH_NAMES);
  const municipalityNames = new Set<string>(NEARBY_MUNICIPALITIES);
  return {
    parishes: normalizedNameEntries(source.parishes).filter(
      (name) => !parishNames.has(name),
    ),
    municipalities: normalizedNameEntries(source.alsoTravelsTo).filter(
      (name) => !municipalityNames.has(name),
    ),
  };
}

/** The kind of a listing. `online` wins over `mobile`; the write rules never store both. */
export function listingKindOf(listing: ListingKindSource): ListingKind {
  if (listing.online === true) return 'online';
  return listing.mobile === true ? 'mobile' : 'place';
}

function isCoordinate(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A mobile listing whose meeting point is set: both coordinates present. */
export function hasListingMeetingPoint(
  listing: ListingMeetingPointSource,
): boolean {
  return (
    listingKindOf(listing) === 'mobile' &&
    isCoordinate(listing.latitude) &&
    isCoordinate(listing.longitude)
  );
}

/** A mobile listing with no meeting point, which stores no address at all. */
export function isMobileWithoutMeetingPoint(
  listing: ListingMeetingPointSource,
): boolean {
  return (
    listingKindOf(listing) === 'mobile' && !hasListingMeetingPoint(listing)
  );
}

/** What every response carries: the normalised details of a mobile listing, the default for any other kind. */
export function toListingMobileDetailsView(
  listing: ListingKindSource & { mobileDetails?: unknown },
): ListingMobileDetails {
  return listingKindOf(listing) === 'mobile'
    ? normalizeListingMobileDetails(listing.mobileDetails)
    : emptyListingMobileDetails();
}
