import { MemberRef } from '../common/member-ref';
import {
  ListingOwnerOffer,
  ListingOwnerOfferStatus,
} from './entities/listing-owner-offer.entity';

/**
 * The staff-console and member-facing view of an owner offer on a listing
 * that has no owner.
 *
 * Carries the listing's `ref`, public `slug` and `name` denormalized onto the
 * row, exactly as `ListingClaimDTO` does and for the same reason: `ref` is the
 * ownership key every mutation route takes, `slug` is the only identifier the
 * public detail page answers to, and a member reading their own offers needs
 * both without a second lookup. The mappers skip an offer whose listing has
 * been hard-deleted, so a DTO only exists where the listing row does.
 *
 * `offeree` and `offeredBy` are `MemberRef | null`. `offeredBy` goes null once
 * the offering admin's account has been erased (the FK is `ON DELETE SET
 * NULL`); `offeree` goes null when the member has no resolvable profile. The
 * offer record survives either way.
 */
export interface ListingOwnerOfferDTO {
  id: string;
  listingRef: string;
  listingSlug: string;
  listingName: string;
  offeree: MemberRef | null;
  offeredBy: MemberRef | null;
  note: string | null;
  status: ListingOwnerOfferStatus;
  /** ISO 8601 timestamp. */
  offeredAt: string;
  /** ISO 8601 timestamp, or `null` while the offer is still open. */
  respondedAt: string | null;
}

/**
 * The three listing fields the mapper reads, kept structural so a caller
 * holding a narrowly selected row can pass it straight in.
 */
export interface ListingOwnerOfferListingSource {
  ref: string;
  slug: string;
  name: string;
}

/**
 * Both member refs are passed in already resolved, so a list call batches one
 * `MemberLookup.byUserIds` across every row it maps. Mirrors
 * `toListingClaimDTO`.
 */
export function toListingOwnerOfferDTO(
  offer: ListingOwnerOffer,
  listing: ListingOwnerOfferListingSource,
  offeree: MemberRef | null,
  offeredBy: MemberRef | null,
): ListingOwnerOfferDTO {
  return {
    id: offer.id,
    listingRef: listing.ref,
    listingSlug: listing.slug,
    listingName: listing.name,
    offeree,
    offeredBy,
    note: offer.note,
    status: offer.status,
    offeredAt: offer.offeredAt.toISOString(),
    respondedAt: offer.respondedAt ? offer.respondedAt.toISOString() : null,
  };
}
