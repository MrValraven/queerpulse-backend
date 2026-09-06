/**
 * The two `features` chips the housing board filters on, and the one
 * normalisation every evaluator of those filters shares.
 *
 * `features` is a free-form `text[]`: `CreateHousingListingDto` accepts any 20
 * strings of 60 characters, so nothing on the server pins an entry to a known
 * chip. In practice the values come from the frontend's curated picker
 * (`queerpulse/src/features/economy/listSpaceOptions.data.ts`), whose `value`
 * is the canonical ENGLISH string that gets stored while `labelKey` is only
 * what the lister reads. These two constants are that picker's `Furnished` and
 * `Pets welcome`, restated here because the picker itself is frontend-only.
 *
 * MATCHING IS CASE-INSENSITIVE EXACT, on the whole entry. Two deliberate calls:
 *
 * - Case-insensitive, because the column is unvalidated. A row written straight
 *   through the API can hold `furnished` or `PETS WELCOME`, and the same
 *   case-insensitive equality already governs the `city`/`area` filters.
 * - Whole entry rather than a substring, because substring matching is unsafe
 *   here in both directions: `Unfurnished` contains `furnished`, and
 *   `No pets welcome` contains `pets welcome`. A renter who ticks "furnished"
 *   and is shown unfurnished rooms is worse off than one who misses a listing
 *   that spelled the chip its own way.
 *
 * The cost is that a hand-typed near-miss (`Fully furnished`) does not match.
 * That is the honest trade: the picker is how a lister states these, and a
 * missed listing is recoverable by clearing the filter.
 */
export const HOUSING_FURNISHED_FEATURE = 'Furnished';
export const HOUSING_PETS_WELCOME_FEATURE = 'Pets welcome';

/**
 * The single comparison key behind both the browse SQL and the in-memory
 * saved-search twin. The SQL spells it `lower(btrim(...))`; keep the two in
 * step if this ever changes.
 *
 * Values written through `HousingListingsService` are already trimmed
 * (`toStoredPlainText`), so the trim only matters for a row inserted outside
 * the service. Postgres `btrim` strips spaces where JavaScript `trim` also
 * strips other whitespace, so a feature padded with a tab could in principle
 * match in memory and not in SQL. No write path in the app can produce one.
 */
export function normalizeHousingFeature(feature: string): string {
  return feature.trim().toLowerCase();
}

/** Whether a listing's stored `features` carry a canonical chip. */
export function hasHousingFeature(
  features: string[],
  canonicalFeature: string,
): boolean {
  const wanted = normalizeHousingFeature(canonicalFeature);
  return features.some(
    (feature) => normalizeHousingFeature(feature) === wanted,
  );
}
