import { IsNotEmpty, IsString, MaxLength, validateSync } from 'class-validator';
import { IsSafeExternalUrl } from '../common/validators/is-safe-external-url.decorator';

/**
 * The `Listing` columns an accepted edit suggestion can be written to
 * (`ListingEditSuggestionsService.applyAcceptedBestEffort`). Keyed by column,
 * not by the suggestion's `field`, because `hours` lands on `hoursNote` and
 * `description` lands on `tagline`.
 */
export type AcceptedSuggestionTarget =
  'address' | 'phone' | 'website' | 'hoursNote' | 'tagline';

/**
 * Re-declares each writable target with the SAME class-validator rules the
 * create path applies to that column, so an accepted suggestion can never
 * persist a value `POST /listings` would have rejected.
 *
 * Why a probe class rather than hand-rolled checks: `website` must run the real
 * `@IsSafeExternalUrl()` decorator, not a copy of its scheme blocklist. That
 * decorator also strips control characters before testing, so a re-implementation
 * here would drift the moment the shared one is hardened. Validating an instance
 * of this class runs the genuine article.
 *
 * Bounds mirror `CreateListingDto` / `ListingSocialDto` exactly:
 *   address  — `@MaxLength(300)`  (create-listing.dto.ts `address`)
 *   phone    — `@MaxLength(60)`   (`ListingSocialDto.phone`)
 *   website  — `@IsSafeExternalUrl()` + `@MaxLength(300)` (`ListingSocialDto.website`)
 *   hoursNote— `@MaxLength(300)`  (create-listing.dto.ts `hoursNote`)
 *   tagline  — `@MaxLength(200)`  (create-listing.dto.ts `tagline`)
 *
 * Every field is optional-by-absence: `validateSync` runs with
 * `skipMissingProperties`, so only the one target actually set is checked.
 */
class AcceptedSuggestionValueProbe {
  @IsString() @IsNotEmpty() @MaxLength(300) address?: string;

  @IsString() @IsNotEmpty() @MaxLength(60) phone?: string;

  @IsString()
  @IsNotEmpty()
  @IsSafeExternalUrl()
  @MaxLength(300)
  website?: string;

  @IsString() @IsNotEmpty() @MaxLength(300) hoursNote?: string;

  @IsString() @IsNotEmpty() @MaxLength(200) tagline?: string;
}

/**
 * True when `value` is safe to write to `target`.
 *
 * BE-HSG-04: `CreateEditSuggestionDto.message` is 2000 chars of unconstrained
 * free text, and accepting a suggestion used to copy it verbatim into
 * `social.website`, `social.phone`, `address` and `tagline` — bypassing the
 * `@IsSafeExternalUrl()` guard the create path puts on `website` precisely so a
 * `javascript:` or `data:` URL can never be stored, and letting a 2000-char blob
 * land in a column the public detail page renders as an address and a map pin.
 *
 * The caller resolves the queue row either way; a rejected value simply is not
 * written. That ordering is deliberate: a moderator's accept/dismiss decision on
 * the suggestion is theirs to make, but it must not be able to persist a value
 * the member could not have submitted directly.
 */
export function isAcceptedSuggestionValueValid(
  target: AcceptedSuggestionTarget,
  value: string,
): boolean {
  const probe = new AcceptedSuggestionValueProbe();
  // Assigned through an explicit switch rather than `probe[target] = value`, so
  // the write is checked against the one real property each time instead of
  // relying on how TypeScript resolves a write through a union-typed key.
  switch (target) {
    case 'address':
      probe.address = value;
      break;
    case 'phone':
      probe.phone = value;
      break;
    case 'website':
      probe.website = value;
      break;
    case 'hoursNote':
      probe.hoursNote = value;
      break;
    case 'tagline':
      probe.tagline = value;
      break;
  }
  const errors = validateSync(probe, {
    skipMissingProperties: true,
    forbidUnknownValues: true,
  });
  return errors.length === 0;
}
