import { BadRequestException } from '@nestjs/common';
import type { Listing } from './entities/listing.entity';
import {
  emptyListingMobileDetails,
  findUnknownMobileAreaNames,
  normalizeListingMobileDetails,
} from './listing-mobile-details';

/**
 * The write rules for listings with no fixed premises ("Out and about"), as
 * one pure step the service runs right after the online rules
 * (`resolveOnlineListingFields`), on their output, on every listing write
 * path: `ListingsService.create` and `adminCreate` (through
 * `resolveCreateKindFields`; staff drafts finish through `adminCreate`), and
 * `applyListingEdit`, which the owner `update` and the staff `adminUpdate`
 * share. Pure and I/O-free, so every rule is pinned by
 * `listing-mobile-rules.spec.ts`.
 *
 * Numbered as the design numbers them (section 2.3):
 *  1. `online` and `mobile` together is a 400 (`assertSingleListingKind`,
 *     which the service also calls before the online rules, so this conflict
 *     is the error a caller sees first).
 *  2. A listing that is not mobile carries the default details.
 *  3. "All of Lisbon" empties the parishes.
 *  4. "Some parishes" with none picked is a 400.
 *  5. A parish or municipality outside the vocabularies is a 400.
 *  6. `hasOnlineShop` is the online rules' business; they treat a mobile
 *     listing as a place.
 *  7. A mobile listing without both coordinates stores no location: blank
 *     `address` and `hood`, no pin, `geocoded` false.
 */

export type MobileListingFieldName =
  | 'online'
  | 'mobile'
  | 'mobileDetails'
  | 'hood'
  | 'address'
  | 'geocoded'
  | 'latitude'
  | 'longitude';

export type MobileListingFields = Pick<Listing, MobileListingFieldName>;

/**
 * What `resolveMobileListingFields` reads: the row's fields, with
 * `mobileDetails` in whatever shape the request or the row holds. The result
 * always carries the complete, normalised value.
 */
export type MobileListingInput = Omit<MobileListingFields, 'mobileDetails'> & {
  mobileDetails: unknown;
};

export const ONLINE_AND_MOBILE_MESSAGE =
  'A listing that is out and about (mobile) cannot also be online only.';

export const PARISHES_REQUIRED_MESSAGE =
  'mobileDetails.parishes needs at least one parish when allOfCity is false.';

/** Rule 1, on a body or on a row as a PATCH leaves it. */
export function assertSingleListingKind(flags: {
  online?: boolean | null;
  mobile?: boolean | null;
}): void {
  if (flags.online === true && flags.mobile === true) {
    throw new BadRequestException(ONLINE_AND_MOBILE_MESSAGE);
  }
}

/** The fields `resolveMobileListingFields` reads and returns, copied off a row. */
export function pickMobileListingFields(
  source: MobileListingFields,
): MobileListingFields {
  return {
    online: source.online,
    mobile: source.mobile,
    mobileDetails: source.mobileDetails,
    hood: source.hood,
    address: source.address,
    geocoded: source.geocoded,
    latitude: source.latitude,
    longitude: source.longitude,
  };
}

function isCoordinate(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The mobile fields as the listing will be stored, or a 400 naming the first
 * rule the input breaks. Throws before anything is written.
 */
export function resolveMobileListingFields(
  input: MobileListingInput,
): MobileListingFields {
  assertSingleListingKind(input);

  const unknownNames = findUnknownMobileAreaNames(input.mobileDetails);
  const [firstUnknownParish] = unknownNames.parishes;
  if (firstUnknownParish !== undefined) {
    throw new BadRequestException(
      `mobileDetails.parishes holds a name outside the 24 Lisbon parishes: "${firstUnknownParish}".`,
    );
  }
  const [firstUnknownMunicipality] = unknownNames.municipalities;
  if (firstUnknownMunicipality !== undefined) {
    throw new BadRequestException(
      `mobileDetails.alsoTravelsTo holds a name outside the nearby municipalities: "${firstUnknownMunicipality}".`,
    );
  }

  const submittedLocation = {
    hood: input.hood,
    address: input.address,
    geocoded: input.geocoded,
    latitude: input.latitude,
    longitude: input.longitude,
  };
  if (input.mobile !== true) {
    return {
      online: input.online,
      mobile: false,
      mobileDetails: emptyListingMobileDetails(),
      ...submittedLocation,
    };
  }

  const mobileDetails = normalizeListingMobileDetails(input.mobileDetails);
  if (!mobileDetails.allOfCity && mobileDetails.parishes.length === 0) {
    throw new BadRequestException(PARISHES_REQUIRED_MESSAGE);
  }
  const hasMeetingPoint =
    isCoordinate(input.latitude) && isCoordinate(input.longitude);
  return {
    online: false,
    mobile: true,
    mobileDetails,
    ...(hasMeetingPoint
      ? submittedLocation
      : {
          hood: '',
          address: '',
          geocoded: false,
          latitude: null,
          longitude: null,
        }),
  };
}

/**
 * Brings a loaded row's `mobileDetails` up to its complete shape (the `'{}'` a
 * row from before the column holds, or a stray value on a row that is not
 * mobile). Run before an edit takes its "before" snapshot, beside
 * `healStoredListingColumns`, so an unrelated PATCH records no change.
 */
export function healStoredMobileDetails(
  listing: Pick<Listing, 'mobile' | 'mobileDetails'>,
): void {
  listing.mobileDetails =
    listing.mobile === true
      ? normalizeListingMobileDetails(listing.mobileDetails)
      : emptyListingMobileDetails();
}
