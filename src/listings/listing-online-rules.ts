import { BadRequestException } from '@nestjs/common';
import type { Listing } from './entities/listing.entity';
import { normalizeListingAccessibilityAnswers } from './listing-accessibility';
import {
  ADULT_LISTING_CATEGORY_SLUG,
  isAdultListing,
  isListingCategoryOffered,
} from './listing-categories';
import { defaultPricingModeForCats } from './listing-menu';
import {
  ListingOnlineDetails,
  emptyListingOnlineDetails,
  normalizeListingOnlineDetails,
} from './listing-online-details';
import {
  ListingShopItem,
  normalizeListingShopItems,
} from './listing-shop-items';

/**
 * The write rules for listings that sell online, as one pure step the service
 * runs on a create body (`ListingsService.create`, `adminCreate`) and on a row
 * as a PATCH leaves it (`applyListingEdit`). Pure and I/O-free, so every rule
 * is pinned by `listing-online-rules.spec.ts`.
 *
 * The rules, numbered as the wire contract numbers them:
 *  1. An online-only listing carries no location and no `hasOnlineShop`.
 *  2. A listing that does not sell online carries empty online details (the
 *     18+ acceptance stamp aside), no shop items and no `shop` pricing mode.
 *  3. A place that also sells online has an address, so pick-up is left out.
 *  4. A listing that sells online needs a main link. Checked on every
 *     create, and on an update only when the PATCH touched `online`,
 *     `hasOnlineShop` or `onlineDetails` (`shouldRequireMainLink`), so an
 *     older online listing with no main link can still save an unrelated
 *     edit.
 *  6. The 18+ category needs the terms accepted once; the first acceptance is
 *     stamped here from the server clock.
 * Rule 5, the claim path's delivery-or-session requirement, sits beside the
 * other claim-path checks in `ListingsService.assertPathRequirements`.
 *
 * The acceptance stamp is the server's record. Whatever stamp `fields`
 * carries is discarded: the result holds the stored stamp the caller passes
 * as `storedAdultTermsAcceptedAt`, or the server clock on a first acceptance,
 * so a client can never forge or backdate one.
 */

export type OnlineListingFieldName =
  | 'online'
  | 'hasOnlineShop'
  | 'cats'
  | 'pricingMode'
  | 'onlineDetails'
  | 'shopItems'
  | 'hood'
  | 'address'
  | 'geocoded'
  | 'latitude'
  | 'longitude';

export type OnlineListingFields = Pick<Listing, OnlineListingFieldName>;

export interface OnlineListingRuleOptions {
  /** `adultTermsAccepted === true` on this request. */
  isAdultTermsAcceptedNow: boolean;
  /**
   * The acceptance stamp the stored row holds before this write: `null` on a
   * create, and the healed row's `onlineDetails.adultTermsAcceptedAt` on an
   * update. The only stamp the result can carry over.
   */
  storedAdultTermsAcceptedAt: string | null;
  /**
   * Check every category against the vocabulary for `online`. True on create,
   * and on a PATCH that carries `cats` or `online`, so a legacy category value
   * on an old row never blocks an unrelated edit.
   */
  shouldCheckCategories: boolean;
  /**
   * Enforce rule 4. True on create, and on a PATCH that carries `online`,
   * `hasOnlineShop` or `onlineDetails`.
   */
  shouldRequireMainLink: boolean;
  /** The server clock, for the first acceptance stamp. */
  now: Date;
}

/** The coded 400 for an 18+ listing whose terms were never accepted. */
export const ADULT_TERMS_REQUIRED_CODE = 'adult_terms_required';

/** The fields `resolveOnlineListingFields` reads and returns, copied off a row or a normalised body. */
export function pickOnlineListingFields(
  source: OnlineListingFields,
): OnlineListingFields {
  return {
    online: source.online,
    hasOnlineShop: source.hasOnlineShop,
    cats: source.cats,
    pricingMode: source.pricingMode,
    onlineDetails: source.onlineDetails,
    shopItems: source.shopItems,
    hood: source.hood,
    address: source.address,
    geocoded: source.geocoded,
    latitude: source.latitude,
    longitude: source.longitude,
  };
}

function categoryNotOffered(
  category: string,
  isOnline: boolean,
): BadRequestException {
  return new BadRequestException(
    `Category "${category}" is not offered to ${isOnline ? 'online' : 'place'} listings`,
  );
}

function adultTermsRequired(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: ADULT_TERMS_REQUIRED_CODE,
    message:
      'A listing in the 18+ category needs the 18+ terms accepted first.',
  });
}

/**
 * The online fields as the listing will be stored, or a 400 naming the first
 * rule the input breaks. Throws before anything is written.
 */
export function resolveOnlineListingFields(
  fields: OnlineListingFields,
  options: OnlineListingRuleOptions,
): OnlineListingFields {
  const isOnline = fields.online === true;
  if (options.shouldCheckCategories) {
    for (const category of fields.cats) {
      if (!isListingCategoryOffered(category, isOnline)) {
        throw categoryNotOffered(category, isOnline);
      }
    }
  }
  const isAdult = isAdultListing(fields.cats);
  if (isAdult && !isOnline) {
    throw categoryNotOffered(ADULT_LISTING_CATEGORY_SLUG, false);
  }

  const hasOnlineShop = !isOnline && fields.hasOnlineShop === true;
  const isSellingOnline = isOnline || hasOnlineShop;
  const submittedDetails = normalizeListingOnlineDetails(fields.onlineDetails);

  let onlineDetails: ListingOnlineDetails;
  let shopItems: ListingShopItem[];
  let pricingMode = fields.pricingMode;
  if (!isSellingOnline) {
    onlineDetails = emptyListingOnlineDetails();
    shopItems = [];
    if (pricingMode === 'shop') {
      pricingMode = defaultPricingModeForCats(fields.cats);
    }
  } else {
    onlineDetails = hasOnlineShop
      ? {
          ...submittedDetails,
          fulfilment: submittedDetails.fulfilment.filter(
            (option) => option !== 'pickupLisbon',
          ),
          pickupNote: '',
        }
      : submittedDetails;
    shopItems = normalizeListingShopItems(fields.shopItems);
    if (options.shouldRequireMainLink && onlineDetails.mainLink === null) {
      throw new BadRequestException('onlineDetails.mainLink is required');
    }
  }

  // Only the stored stamp or the server clock reaches the result; the stamp
  // inside `fields.onlineDetails` may have come from a request body.
  let adultTermsAcceptedAt = options.storedAdultTermsAcceptedAt;
  if (isAdult && adultTermsAcceptedAt === null) {
    if (!options.isAdultTermsAcceptedNow) {
      throw adultTermsRequired();
    }
    adultTermsAcceptedAt = options.now.toISOString();
  }
  onlineDetails = { ...onlineDetails, adultTermsAcceptedAt };

  return {
    online: isOnline,
    hasOnlineShop,
    cats: fields.cats,
    pricingMode,
    onlineDetails,
    shopItems,
    hood: isOnline ? '' : fields.hood,
    address: isOnline ? '' : fields.address,
    geocoded: isOnline ? false : fields.geocoded,
    latitude: isOnline ? null : fields.latitude,
    longitude: isOnline ? null : fields.longitude,
  };
}

/**
 * Brings a loaded row's newer jsonb columns up to their complete shapes
 * (`'{}'` online details, a missing shop item list, six accessibility
 * answers). Run before an edit takes its "before" snapshot, so the snapshot
 * and the edited row compare like with like and an unrelated PATCH records no
 * change.
 */
export function healStoredListingColumns(
  listing: Pick<
    Listing,
    'onlineDetails' | 'shopItems' | 'accessibilityAnswers'
  >,
): void {
  listing.onlineDetails = normalizeListingOnlineDetails(listing.onlineDetails);
  listing.shopItems = normalizeListingShopItems(listing.shopItems);
  listing.accessibilityAnswers = normalizeListingAccessibilityAnswers(
    listing.accessibilityAnswers,
  );
}

/** An online-only listing's "Based in" city: as typed, trimmed, possibly empty. */
export function resolveOnlineListingCity(
  raw: string | null | undefined,
): string {
  return (raw ?? '').trim();
}
