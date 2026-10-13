import { BadRequestException } from '@nestjs/common';
import {
  COVER_POLICY_CATEGORY_SLUGS,
  ListingCoverPolicy,
  ListingEntryMode,
  ListingInclusionPractice,
  ListingPaymentMethod,
  MAX_LISTING_HIGHLIGHTS,
  MAX_SAFER_SPACE_POLICY_URL_LENGTH,
  SAFER_SPACE_POLICY_PRACTICE,
  canonicalListingSlugs,
  isSensitiveListingAttribute,
  normalizeListingAttributes,
  normalizeListingInclusionPractices,
  normalizeListingPayments,
} from './listing-attributes';
import { ListingKindSource, listingKindOf } from './listing-mobile-details';
import { normalizeOnlineListingUrl } from './listing-online-details';

/**
 * The write rules for listing attributes and the "getting in" facts, as one
 * pure step the service runs on every listing write, after the online rules
 * (`resolveOnlineListingFields`) and the mobile rules
 * (`resolveMobileListingFields`), on the row as the write leaves it:
 * `ListingsService.create` and `adminCreate` (through
 * `resolveCreateKindFields`; suggestions and claims included), and
 * `applyListingEdit`, which the owner, co-manager and staff edits share.
 * Pure and I/O-free, so every rule is pinned by
 * `listing-attribute-rules.spec.ts`.
 *
 * Numbered as the wire contract numbers them:
 *  1. Every `attributes` slug is in the vocabulary (or already stored).
 *  2. A slug the row does not already carry is offered to its kind and
 *     categories. Stored slugs stay valid after a category change.
 *  3. Highlights sit inside the resulting attributes and are never sensitive.
 *     A write that sends no highlights loses, silently, any whose attribute it
 *     removed.
 *  4. An online listing carries no way in, no cover and no in-person ways to
 *     pay.
 *  5. Only a `nightlife` or `culture` listing carries a cover.
 *  6. `freeBefore` needs its time; every other cover carries none.
 *  7. A new practice sits inside its scope (stored ones stay), and
 *     `safer-space-policy` needs its link, stored with `https://`.
 */

export interface ListingAttributeFields {
  attributes: string[];
  highlights: string[];
  entryMode: ListingEntryMode | null;
  coverPolicy: ListingCoverPolicy | null;
  coverFreeBefore: string | null;
  payments: ListingPaymentMethod[];
  issuesNifInvoices: boolean | null;
  inclusionPractices: ListingInclusionPractice[];
  saferSpacePolicyUrl: string | null;
}

export type ListingAttributeFieldName = keyof ListingAttributeFields;

/**
 * The row as the write leaves it: the kind flags and categories the online
 * and mobile rules settled, and the nine fields as merged. A `Listing` row
 * satisfies it as is. Every field may be missing on a row read from before
 * the columns existed.
 */
export interface ListingAttributeRuleInput extends ListingKindSource {
  cats: readonly string[] | null | undefined;
  attributes: readonly string[] | null | undefined;
  highlights: readonly string[] | null | undefined;
  entryMode: ListingEntryMode | null | undefined;
  coverPolicy: ListingCoverPolicy | null | undefined;
  coverFreeBefore: string | null | undefined;
  payments: readonly string[] | null | undefined;
  issuesNifInvoices: boolean | null | undefined;
  inclusionPractices: readonly string[] | null | undefined;
  saferSpacePolicyUrl: string | null | undefined;
}

export interface ListingAttributeRuleOptions {
  /** The attributes the row held before this write: `[]` on a create. */
  storedAttributes: readonly string[] | null | undefined;
  /** The practices the row held before this write: `[]` on a create. */
  storedInclusionPractices: readonly string[] | null | undefined;
  /** True when this write's body carries `highlights` (rule 3). */
  hasHighlightsInWrite: boolean;
}

export function unknownListingAttributesMessage(
  slugs: readonly string[],
): string {
  return (
    `Unknown listing attributes: ${slugs.map((slug) => `"${slug}"`).join(', ')}. ` +
    'Pick from GET /directory/attributes.'
  );
}

export function attributeNotOfferedMessage(slug: string): string {
  return `Attribute "${slug}" is not offered to this listing.`;
}

export function highlightNotAnAttributeMessage(slug: string): string {
  return `Highlight "${slug}" is not one of this listing's attributes.`;
}

export function highlightNotAllowedMessage(slug: string): string {
  return `"${slug}" cannot be a highlight.`;
}

export const COVER_FREE_BEFORE_REQUIRED_MESSAGE =
  'coverFreeBefore is required when coverPolicy is freeBefore.';

export function practiceNotOfferedMessage(slug: string): string {
  return `Practice "${slug}" is not offered to this listing.`;
}

export const SAFER_SPACE_POLICY_URL_REQUIRED_MESSAGE =
  'saferSpacePolicyUrl is required when safer-space-policy is set.';

export const SAFER_SPACE_POLICY_URL_TOO_LONG_MESSAGE = `saferSpacePolicyUrl must be at most ${MAX_SAFER_SPACE_POLICY_URL_LENGTH} characters once https:// is added.`;

/** Rule 3. */
function resolveHighlights(
  requested: readonly string[] | null | undefined,
  attributes: readonly string[],
  hasHighlightsInWrite: boolean,
): string[] {
  const requestedHighlights = canonicalListingSlugs(requested);
  if (!hasHighlightsInWrite) {
    return requestedHighlights
      .filter(
        (slug) =>
          attributes.includes(slug) && !isSensitiveListingAttribute(slug),
      )
      .slice(0, MAX_LISTING_HIGHLIGHTS);
  }
  for (const slug of requestedHighlights) {
    if (!attributes.includes(slug)) {
      throw new BadRequestException(highlightNotAnAttributeMessage(slug));
    }
    if (isSensitiveListingAttribute(slug)) {
      throw new BadRequestException(highlightNotAllowedMessage(slug));
    }
  }
  return requestedHighlights.slice(0, MAX_LISTING_HIGHLIGHTS);
}

/** Rule 7's link: required, `https://` prefixed when typed without a protocol, at most the column width. */
function resolveSaferSpacePolicyUrl(raw: string | null | undefined): string {
  const trimmedUrl = raw?.trim() ?? '';
  const normalizedUrl =
    trimmedUrl === '' ? null : normalizeOnlineListingUrl(trimmedUrl);
  if (normalizedUrl === null) {
    throw new BadRequestException(SAFER_SPACE_POLICY_URL_REQUIRED_MESSAGE);
  }
  if (normalizedUrl.length > MAX_SAFER_SPACE_POLICY_URL_LENGTH) {
    throw new BadRequestException(SAFER_SPACE_POLICY_URL_TOO_LONG_MESSAGE);
  }
  return normalizedUrl;
}

/**
 * The nine fields as the listing will be stored, or a 400 naming the first
 * rule the input breaks. Throws before anything is written.
 */
export function resolveListingAttributeFields(
  input: ListingAttributeRuleInput,
  options: ListingAttributeRuleOptions,
): ListingAttributeFields {
  const kind = listingKindOf(input);
  const categories = input.cats ?? [];

  // Rules 1 and 2.
  const normalizedAttributes = normalizeListingAttributes(
    input.attributes,
    options.storedAttributes,
    kind,
    categories,
  );
  if (normalizedAttributes.unknown.length > 0) {
    throw new BadRequestException(
      unknownListingAttributesMessage(normalizedAttributes.unknown),
    );
  }
  const [firstNotOfferedAttribute] = normalizedAttributes.notOffered;
  if (firstNotOfferedAttribute !== undefined) {
    throw new BadRequestException(
      attributeNotOfferedMessage(firstNotOfferedAttribute),
    );
  }
  const attributes = normalizedAttributes.attributes;

  // Rule 3.
  const highlights = resolveHighlights(
    input.highlights,
    attributes,
    options.hasHighlightsInWrite,
  );

  // Rules 4, 5 and 6.
  const isOnline = kind === 'online';
  const hasCoverCategory = categories.some((category) =>
    (COVER_POLICY_CATEGORY_SLUGS as readonly string[]).includes(category),
  );
  const coverPolicy =
    isOnline || !hasCoverCategory ? null : (input.coverPolicy ?? null);
  const trimmedFreeBefore = input.coverFreeBefore?.trim() ?? '';
  const coverFreeBefore =
    coverPolicy === 'freeBefore' && trimmedFreeBefore !== ''
      ? trimmedFreeBefore
      : null;
  if (coverPolicy === 'freeBefore' && coverFreeBefore === null) {
    throw new BadRequestException(COVER_FREE_BEFORE_REQUIRED_MESSAGE);
  }

  // Rule 7.
  const normalizedPractices = normalizeListingInclusionPractices(
    input.inclusionPractices,
    options.storedInclusionPractices,
    kind,
    categories,
  );
  const [firstNotOfferedPractice] = normalizedPractices.notOffered;
  if (firstNotOfferedPractice !== undefined) {
    throw new BadRequestException(
      practiceNotOfferedMessage(firstNotOfferedPractice),
    );
  }
  const saferSpacePolicyUrl = normalizedPractices.inclusionPractices.includes(
    SAFER_SPACE_POLICY_PRACTICE,
  )
    ? resolveSaferSpacePolicyUrl(input.saferSpacePolicyUrl)
    : null;

  return {
    attributes,
    highlights,
    entryMode: isOnline ? null : (input.entryMode ?? null),
    coverPolicy,
    coverFreeBefore,
    payments: isOnline ? [] : normalizeListingPayments(input.payments),
    issuesNifInvoices: input.issuesNifInvoices ?? null,
    inclusionPractices: normalizedPractices.inclusionPractices,
    saferSpacePolicyUrl,
  };
}
