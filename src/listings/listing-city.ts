/**
 * The one city the QueerPulse directory serves.
 *
 * Mirrors `housing-listings/housing-city.ts` deliberately: there is no cities
 * table, no city switcher and no multi-city abstraction, so the city is a
 * constant the BACKEND owns rather than a value the client is trusted to send.
 *
 * Before this, `createListingInput` stored `city: dto.city ?? ''` and
 * `timezone: dto.timezone ?? ''`, and the listings wizard sent neither. Two
 * things broke quietly as a result:
 *
 *  - Every member-created listing stored an EMPTY city, and the reader hid it
 *    with `listing.city || 'Lisbon'` at the one place it was rendered. The
 *    fallback made the data look fine while the column stayed empty, so
 *    anything querying the column (rather than rendering it) saw nothing.
 *  - An empty `timezone` makes `openStatus` unable to resolve a venue-local
 *    clock, so the whole opening-hours feature answers "unknown" for exactly
 *    the listings members create themselves.
 *
 * Fixing the write is what makes the fallback removable. If a second city ever
 * becomes real, this file is the single place that changes, and the columns
 * (`listings.city`, `listings.timezone`) already carry the values.
 */
export const LISTING_CITY = 'Lisbon';

/** IANA zone every listing's opening hours are expressed in. */
export const LISTING_TIMEZONE = 'Europe/Lisbon';

/** Accepted spellings of the one city, normalised (lowercase, unaccented). */
const CITY_ALIASES: ReadonlySet<string> = new Set([
  'lisbon',
  'lisboa',
  'lisbonne',
  'lissabon',
]);

/** Accent- and case-insensitive comparison key. Mirrors `housing-city.ts`. */
function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/** Whether a submitted value is one of the accepted spellings of the city. */
export function isListingCityName(value: string): boolean {
  return CITY_ALIASES.has(normalizeName(value));
}

/**
 * Resolves the `city`/`hood` pair a client submitted into the pair that is
 * actually STORED. Same three rules as housing, for the same reasons:
 *
 *  1. `city` is ALWAYS `LISTING_CITY`. Missing, empty, "lisboa" or a
 *     neighbourhood name all store "Lisbon".
 *  2. If the submitted `city` is NOT a spelling of the city and no `hood` came
 *     with it, that value is treated as the neighbourhood and moves into
 *     `hood`, so a client that put the neighbourhood in the city field lands
 *     in the right column instead of being discarded.
 *  3. `hood` otherwise passes through trimmed.
 *
 * A wrong city is never a 400. Correcting the older client beats breaking it.
 * Returns `hood: undefined` when there is nothing to write, so a PATCH caller
 * can leave the stored neighbourhood untouched.
 */
export function resolveListingLocation(input: {
  city?: string | null;
  hood?: string | null;
}): { city: string; hood: string | undefined } {
  const submittedCity = (input.city ?? '').trim();
  const submittedHood =
    input.hood === undefined ? undefined : (input.hood ?? '').trim();

  const isCityActuallyANeighbourhood =
    submittedCity.length > 0 && !isListingCityName(submittedCity);

  if (isCityActuallyANeighbourhood && !submittedHood) {
    return { city: LISTING_CITY, hood: submittedCity };
  }
  return { city: LISTING_CITY, hood: submittedHood };
}

/**
 * The timezone actually stored for a listing.
 *
 * A client may send one (the admin bulk-import path does), but an empty or
 * missing value resolves to the city's zone rather than to `''`. An empty
 * string is not a neutral default here: it is the value that silently disables
 * opening hours.
 */
export function resolveListingTimezone(timezone?: string | null): string {
  const submitted = (timezone ?? '').trim();
  return submitted.length > 0 ? submitted : LISTING_TIMEZONE;
}

/**
 * The city to DISPLAY for a stored listing.
 *
 * Every row written from now on carries a real city, so this only catches rows
 * created before the write path was fixed. It exists so that legacy handling
 * lives in one named place rather than as a `|| 'Lisbon'` sprinkled through the
 * response mappers, where it silently hid the empty column it was compensating
 * for.
 */
export function listingCityOrDefault(city?: string | null): string {
  const stored = (city ?? '').trim();
  return stored.length > 0 ? stored : LISTING_CITY;
}
