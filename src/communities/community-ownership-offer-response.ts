import { MemberRef } from '../common/member-ref';
import {
  CommunityOwnershipOffer,
  CommunityOwnershipOfferStatus,
} from './entities/community-ownership-offer.entity';

/**
 * Machine-readable reason codes for every refusal on the ownership offer
 * routes. The client maps each one to its own copy line.
 */
export const COMMUNITY_OWNERSHIP_OFFER_CODES = {
  /** The community already has an open offer; cancel it first. */
  openOfferExists: 'OWNERSHIP_OFFER_OPEN',
  /** No open offer for this community (owner side) or for this member. */
  notFound: 'OWNERSHIP_OFFER_NOT_FOUND',
  /** The member already accepted or declined the offer. */
  alreadyAnswered: 'OWNERSHIP_OFFER_ANSWERED',
  /** The owner withdrew the offer before the member answered it. */
  cancelled: 'OWNERSHIP_OFFER_CANCELLED',
  /** The offer lapsed at `expiresAt`, or a newer offer closed it as expired. */
  expired: 'OWNERSHIP_OFFER_EXPIRED',
  /** Ownership moved by another route since the offer was made. */
  ownerChanged: 'OWNERSHIP_OFFER_OWNER_CHANGED',
  /** The member offered the community has since left its roster. */
  recipientNotMember: 'OWNERSHIP_OFFER_RECIPIENT_NOT_MEMBER',
  /** The owner tried to offer the community to themselves. */
  selfOffer: 'OWNERSHIP_OFFER_SELF',
  /** The member named already owns the community. */
  alreadyOwner: 'OWNERSHIP_OFFER_ALREADY_OWNER',
  /** The member named is the platform's house account. */
  houseAccount: 'OWNERSHIP_OFFER_HOUSE_ACCOUNT',
  /** The member named is not on this community's roster. */
  memberNotFound: 'OWNERSHIP_OFFER_MEMBER_NOT_FOUND',
} as const;

/**
 * The view of an ownership offer, shared by the owner's panel and the
 * offered member's list.
 *
 * `offeree` and `offeredBy` are `MemberRef | null`: `offeredBy` goes null
 * once the offering account is erased (the FK is `ON DELETE SET NULL`), and
 * either can be the "[deactivated member]" stand-in (`isInactiveMember`)
 * while that account is paused.
 */
export interface CommunityOwnershipOfferDTO {
  id: string;
  communitySlug: string;
  communityName: string;
  offeree: MemberRef | null;
  offeredBy: MemberRef | null;
  status: CommunityOwnershipOfferStatus;
  /** ISO 8601 timestamp. */
  offeredAt: string;
  /** ISO 8601 timestamp. An `offered` row past this reads as `expired`. */
  expiresAt: string;
  /** ISO 8601 timestamp, or `null` while the offer is still open. */
  respondedAt: string | null;
}

/** The two community fields the mapper reads, kept structural. */
export interface CommunityOwnershipOfferCommunitySource {
  slug: string;
  name: string;
}

/**
 * The status a reader should see: an `offered` row whose `expiresAt` has
 * passed reads as `expired` even before a write has flipped it.
 */
export function effectiveOfferStatus(
  offer: Pick<CommunityOwnershipOffer, 'status' | 'expiresAt'>,
  now: Date,
): CommunityOwnershipOfferStatus {
  if (
    offer.status === CommunityOwnershipOfferStatus.Offered &&
    offer.expiresAt.getTime() <= now.getTime()
  ) {
    return CommunityOwnershipOfferStatus.Expired;
  }
  return offer.status;
}

/** Both member refs arrive already resolved, so a list call batches one
 * `MemberLookup.byUserIds` across every row it maps. */
export function toCommunityOwnershipOfferDTO(
  offer: CommunityOwnershipOffer,
  community: CommunityOwnershipOfferCommunitySource,
  offeree: MemberRef | null,
  offeredBy: MemberRef | null,
  now: Date = new Date(),
): CommunityOwnershipOfferDTO {
  return {
    id: offer.id,
    communitySlug: community.slug,
    communityName: community.name,
    offeree,
    offeredBy,
    status: effectiveOfferStatus(offer, now),
    offeredAt: offer.offeredAt.toISOString(),
    expiresAt: offer.expiresAt.toISOString(),
    respondedAt: offer.respondedAt ? offer.respondedAt.toISOString() : null,
  };
}
