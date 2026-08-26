/**
 * The one city QueerPulse housing serves.
 *
 * There is deliberately no cities table, no city switcher and no multi-city
 * abstraction: the platform is Lisbon-only, so the city is a constant the
 * BACKEND owns rather than a value the client is trusted to send. Before this,
 * the "List a space" form sent `city: area.trim()`, so the `city` column held a
 * neighbourhood name ("Arroios"), which corrupted the neighbourhood-centroid
 * pin, the `LOWER(city)` browse filter and the saved-search matcher (it matches
 * on area AND city).
 *
 * If a second city ever becomes real, this file is the single place that
 * changes, and the columns (`housing_listings.city`) already carry the value.
 */
export const HOUSING_CITY = 'Lisbon';

/** IANA zone every housing date/time on this platform is expressed in. */
export const HOUSING_TIMEZONE = 'Europe/Lisbon';

/** Accepted spellings of the one city, normalised (lowercase, unaccented). */
const CITY_ALIASES: ReadonlySet<string> = new Set([
  'lisbon',
  'lisboa',
  'lisbonne',
  'lissabon',
]);

/** Accent- and case-insensitive comparison key. Mirrors `housing-geo.ts`. */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** Whether a submitted value is one of the accepted spellings of the city. */
export function isHousingCityName(value: string): boolean {
  return CITY_ALIASES.has(normalizeName(value));
}

/**
 * Resolves the `city`/`area` pair a client submitted into the pair that is
 * actually STORED.
 *
 * Three rules, in order:
 *  1. `city` is ALWAYS `HOUSING_CITY`. Missing, empty, "lisboa" or "Arroios"
 *     all store "Lisbon", so a neighbourhood name can never reach the column
 *     again. A wrong city is never a 400: the older client that sends the
 *     neighbourhood is corrected rather than broken.
 *  2. If the submitted `city` is NOT a spelling of the city and no `area` was
 *     sent, that value is treated as the neighbourhood and moves into `area`.
 *     This is exactly the shape the old form produced, so its submissions land
 *     with the neighbourhood in the right column instead of being discarded.
 *  3. `area` otherwise passes through trimmed (it stays the lister's own field).
 *
 * Returns `area: undefined` when there is nothing to write, so a PATCH caller
 * can leave the stored area untouched.
 */
export function resolveHousingLocation(input: {
  city?: string | null;
  area?: string | null;
}): { city: string; area: string | undefined } {
  const submittedCity = (input.city ?? '').trim();
  const submittedArea =
    input.area === undefined ? undefined : (input.area ?? '').trim();

  const isCityActuallyANeighbourhood =
    submittedCity.length > 0 && !isHousingCityName(submittedCity);

  if (isCityActuallyANeighbourhood && !submittedArea) {
    return { city: HOUSING_CITY, area: submittedCity };
  }
  return { city: HOUSING_CITY, area: submittedArea };
}
