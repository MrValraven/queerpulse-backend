import { MemberRef } from '../common/member-ref';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from './entities/listing-co-manager.entity';
import { Listing } from './entities/listing.entity';

/**
 * One seat on a listing's co-manager roster, as the OWNER or a fellow
 * co-manager sees it.
 *
 * `member` is the compact cross-domain `MemberRef` every other roster in this
 * codebase embeds. There is no email, no invitation note and no free text of
 * any kind: the roster answers "who has access", and nothing more.
 *
 * `invitedBy` is present because a roster with several seats on it is only
 * auditable if you can see who opened each one. It is null when that account
 * has since been erased.
 *
 * This DTO NEVER appears in a public response. The only mappers that produce it
 * are behind `GET /listings/:ref/co-managers` and the owner-only write routes.
 */
export interface ListingCoManagerDTO {
  id: string;
  member: MemberRef | null;
  status: ListingCoManagerStatus;
  invitedBy: MemberRef | null;
  /** ISO 8601 timestamp. */
  invitedAt: string;
  /** ISO 8601 timestamp, or `null` while the invitation is unanswered. */
  acceptedAt: string | null;
  /** ISO 8601 timestamp of however the seat ended, or `null` while it is live. */
  endedAt: string | null;
}

export function toListingCoManagerDTO(
  seat: ListingCoManager,
  member: MemberRef | null,
  invitedBy: MemberRef | null,
): ListingCoManagerDTO {
  return {
    id: seat.id,
    member,
    status: seat.status,
    invitedBy,
    invitedAt: seat.invitedAt.toISOString(),
    acceptedAt: seat.acceptedAt ? seat.acceptedAt.toISOString() : null,
    endedAt: seat.endedAt ? seat.endedAt.toISOString() : null,
  };
}

/**
 * One pending invitation, as the INVITED member sees it before they answer.
 *
 * The shape is deliberately not `ListingCoManagerDTO`. The person reading this
 * is being asked to decide about a business, so what they need is the business:
 * its name, its public slug so they can go and look at the page, and who asked.
 * They are not shown the rest of the roster, because at this point they are not
 * on it.
 *
 * `listingRef` is included and it is the one field worth pausing on. It is the
 * key to every management route, so it is handed over ONLY on a row that is
 * genuinely addressed to this member. Once they accept it is how they reach
 * `PATCH /listings/:ref`; if they decline they never use it, and knowing it
 * grants nothing on its own, since every `:ref` route re-checks the seat.
 */
export interface ListingCoManagerInviteDTO {
  id: string;
  listingRef: string;
  listingSlug: string;
  listingName: string;
  invitedBy: MemberRef | null;
  status: ListingCoManagerStatus;
  /** ISO 8601 timestamp. */
  invitedAt: string;
}

export function toListingCoManagerInviteDTO(
  seat: ListingCoManager,
  listing: Listing,
  invitedBy: MemberRef | null,
): ListingCoManagerInviteDTO {
  return {
    id: seat.id,
    listingRef: listing.ref,
    listingSlug: listing.slug,
    listingName: listing.name,
    invitedBy,
    status: seat.status,
    invitedAt: seat.invitedAt.toISOString(),
  };
}
