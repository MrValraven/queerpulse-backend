import { randomInt } from 'node:crypto';

/**
 * Pure rules for buying music in Studio (contract sections 1.6, 2.1, 3.1,
 * 3.2 and 3.7). QueerPulse never holds the money: a buyer pays the artist
 * directly, then claims "I've paid", and a persona member confirms. The
 * frontend mirrors the sellable types and the cent limits in
 * `studioPurchaseRules.ts`.
 */

export const STUDIO_SELLABLE_RELEASE_TYPES = ['album', 'ep', 'single'] as const;

export const STUDIO_PURCHASE_LIMITS = {
  fixedPriceMinCents: 100,
  priceMaxCents: 50000,
  minimumPriceMinCents: 0,
  amountMaxCents: 50000,
  payerNameMaxLength: 60,
  declineNoteMaxLength: 200,
  paymentMethodsMax: 8,
  paymentLabelMaxLength: 60,
  paymentValueMaxLength: 500,
  paymentNoteMaxLength: 160,
  artistNameSnapshotMaxLength: 120,
  itemTitleSnapshotMaxLength: 200,
  inboxPerPage: 30,
  salesPerPage: 30,
  purchasesPerPage: 30,
  wallPerPage: 24,
  pendingExpiryDays: 30,
  salesWindowDays: 28,
  downloadUrlExpirySeconds: 900,
} as const;

/** 31 symbols with no 0, O, 1, I or L. */
export const STUDIO_REFERENCE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const REFERENCE_CODE_LENGTH = 6;

export function isSellableReleaseType(type: string): boolean {
  return (STUDIO_SELLABLE_RELEASE_TYPES as readonly string[]).includes(type);
}

/** Six picks of the alphabet. `randomIndex(max)` answers 0 to max - 1. */
export function generateStudioReferenceCode(
  randomIndex: (max: number) => number = randomInt,
): string {
  let code = '';
  for (let position = 0; position < REFERENCE_CODE_LENGTH; position++) {
    code += STUDIO_REFERENCE_CODE_ALPHABET.charAt(
      randomIndex(STUDIO_REFERENCE_CODE_ALPHABET.length),
    );
  }
  return code;
}

export interface StudioPrice {
  mode: 'fixed' | 'name_your_price';
  /** Fixed: the price. Name your price: the minimum. */
  amountCents: number;
}

/** The stored price, or null for an item off sale. */
export function toStudioPrice(
  mode: string,
  cents: number | null,
): StudioPrice | null {
  if (cents === null) return null;
  if (mode !== 'fixed' && mode !== 'name_your_price') return null;
  return { mode, amountCents: cents };
}

export type StudioOfferState = 'can_buy' | 'pending' | 'owned' | 'refused';

export type StudioPurchaseRefusalCode =
  | 'studio_purchase_own_persona'
  | 'studio_purchase_not_for_sale'
  | 'studio_release_type_not_for_sale'
  | 'studio_purchase_release_not_published'
  | 'studio_purchase_track_unavailable'
  | 'studio_purchase_unavailable'
  | 'studio_purchase_no_payment_methods';

export interface StudioOfferFacts {
  isPersonaMember: boolean;
  priceMode: string;
  releaseType: string;
  isOwned: boolean;
  hasPendingClaim: boolean;
  releaseStatus: string;
  isTrackOffer: boolean;
  isTrackWithheld: boolean;
  hasPlayableAudio: boolean;
  isBlocked: boolean;
  hasPaymentMethods: boolean;
}

/** Contract 3.1 rules 4 to 8: the refusal that follows ownership and a
 *  pending claim, or null when the item can be bought. */
function sellingRefusal(
  facts: StudioOfferFacts,
): StudioPurchaseRefusalCode | null {
  const isSellableType = isSellableReleaseType(facts.releaseType);
  if (facts.priceMode === 'not_for_sale' || !isSellableType) {
    return isSellableType
      ? 'studio_purchase_not_for_sale'
      : 'studio_release_type_not_for_sale';
  }
  if (facts.releaseStatus !== 'published') {
    return 'studio_purchase_release_not_published';
  }
  if (
    facts.isTrackOffer &&
    (facts.isTrackWithheld || !facts.hasPlayableAudio)
  ) {
    return 'studio_purchase_track_unavailable';
  }
  if (facts.isBlocked) return 'studio_purchase_unavailable';
  if (!facts.hasPaymentMethods) return 'studio_purchase_no_payment_methods';
  return null;
}

/**
 * The viewer state of an offer, first rule that matches (contract 3.1): own
 * persona; owned (wins over every later rule, so an item taken off sale still
 * shows its download); pending; off sale; unpublished release; track
 * unavailable; blocked; no payment methods; can buy.
 */
export function studioOfferState(facts: StudioOfferFacts): {
  state: StudioOfferState;
  refusalCode: StudioPurchaseRefusalCode | null;
} {
  if (facts.isPersonaMember) {
    return { state: 'refused', refusalCode: 'studio_purchase_own_persona' };
  }
  if (facts.isOwned) return { state: 'owned', refusalCode: null };
  if (facts.hasPendingClaim) return { state: 'pending', refusalCode: null };
  const refusalCode = sellingRefusal(facts);
  if (refusalCode) return { state: 'refused', refusalCode };
  return { state: 'can_buy', refusalCode: null };
}

/**
 * The refusal for a create (contract 3.2 step 3): rules 1, 2 and 4 to 8 in
 * that order. Rule 2 answers `studio_purchase_already_owned`. A pending claim
 * is left to the unique index of step 7.
 */
export function studioCreateRefusal(
  facts: StudioOfferFacts,
): StudioPurchaseRefusalCode | 'studio_purchase_already_owned' | null {
  if (facts.isPersonaMember) return 'studio_purchase_own_persona';
  if (facts.isOwned) return 'studio_purchase_already_owned';
  return sellingRefusal(facts);
}

/**
 * Release route and track route share these price refusals (contract 2.1
 * steps 1 and 2): a price on an unsellable type, then a fixed price under the
 * floor. A null price (off sale) always passes.
 */
export function studioPriceShapeRefusal(
  price: StudioPrice | null,
  releaseTypeAfterWrite: string,
): 'studio_release_type_not_for_sale' | 'studio_price_out_of_range' | null {
  if (price === null) return null;
  if (!isSellableReleaseType(releaseTypeAfterWrite)) {
    return 'studio_release_type_not_for_sale';
  }
  if (
    price.mode === 'fixed' &&
    price.amountCents < STUDIO_PURCHASE_LIMITS.fixedPriceMinCents
  ) {
    return 'studio_price_out_of_range';
  }
  return null;
}

/** Contract 2.1 step 4: a type change to an unsellable type while the release
 *  or any of its tracks is priced. */
export function studioTypeChangeRefusal(input: {
  isTypeChanging: boolean;
  releaseTypeAfterWrite: string;
  hasPricedItemsAfterWrite: boolean;
}): 'studio_release_type_not_for_sale' | null {
  if (
    input.isTypeChanging &&
    !isSellableReleaseType(input.releaseTypeAfterWrite) &&
    input.hasPricedItemsAfterWrite
  ) {
    return 'studio_release_type_not_for_sale';
  }
  return null;
}

/** Contract 3.2 step 5. */
export function studioAmountRefusal(
  price: StudioPrice,
  amountCents: number,
):
  | 'studio_purchase_price_changed'
  | 'studio_purchase_amount_below_minimum'
  | 'studio_purchase_amount_above_cap'
  | null {
  if (price.mode === 'fixed' && amountCents !== price.amountCents) {
    return 'studio_purchase_price_changed';
  }
  if (price.mode === 'name_your_price' && amountCents < price.amountCents) {
    return 'studio_purchase_amount_below_minimum';
  }
  if (amountCents > STUDIO_PURCHASE_LIMITS.amountMaxCents) {
    return 'studio_purchase_amount_above_cap';
  }
  return null;
}

export type StudioLiveDownloadFacts = {
  releaseStatus: string;
  isPersonaRemoved: boolean;
  isPersonaModerated: boolean;
  isTrackWithheld: boolean;
  audioKey: string | null;
  audioContentType: string | null;
};

/**
 * Contract 3.7 steps 5 to 8. Draft and scheduled releases and private
 * personas still download; only a takedown, a removed or moderated persona, a
 * withheld track or missing audio stop a file.
 */
export function studioLiveDownloadRefusal(
  facts: StudioLiveDownloadFacts,
):
  | 'studio_download_release_taken_down'
  | 'studio_download_artist_unavailable'
  | 'studio_download_track_withheld'
  | 'studio_download_track_not_ready'
  | null {
  if (facts.releaseStatus === 'taken_down') {
    return 'studio_download_release_taken_down';
  }
  if (facts.isPersonaRemoved || facts.isPersonaModerated) {
    return 'studio_download_artist_unavailable';
  }
  if (facts.isTrackWithheld) return 'studio_download_track_withheld';
  if (facts.audioKey === null || facts.audioContentType === null) {
    return 'studio_download_track_not_ready';
  }
  return null;
}

export function studioDownloadFormat(
  contentType: string | null,
): 'mp3' | 'm4a' | null {
  if (contentType === 'audio/mpeg') return 'mp3';
  if (contentType === 'audio/mp4') return 'm4a';
  return null;
}

/** The base of the downloaded file name: `"{artist} - {track}"`. */
export function studioDownloadDisplayName(
  artistName: string,
  trackTitle: string,
): string {
  return `${artistName} - ${trackTitle}`;
}

function cutToCodePoints(text: string, maxCodePoints: number): string {
  return Array.from(text).slice(0, maxCodePoints).join('');
}

/** The trimmed display name, the handle when it is blank, cut to 120 code
 *  points. */
export function studioArtistNameSnapshot(
  displayName: string | null,
  handle: string | null,
): string {
  const trimmedName = (displayName ?? '').trim();
  const name = trimmedName === '' ? (handle ?? '') : trimmedName;
  return cutToCodePoints(
    name,
    STUDIO_PURCHASE_LIMITS.artistNameSnapshotMaxLength,
  );
}

export function studioItemTitleSnapshot(title: string): string {
  return cutToCodePoints(
    title,
    STUDIO_PURCHASE_LIMITS.itemTitleSnapshotMaxLength,
  );
}

/** The violated constraint of a Postgres unique violation (`23505`), read on
 *  the error or on its `driverError`; null for anything else. */
export function uniqueViolationConstraint(error: unknown): string | null {
  const candidates: unknown[] = [error];
  if (typeof error === 'object' && error !== null) {
    candidates.push((error as { driverError?: unknown }).driverError);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { code, constraint } = candidate as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === '23505' && typeof constraint === 'string') return constraint;
  }
  return null;
}
