import { MemberRef, toMemberRef } from '../common/member-ref';
import { matchNeighbourhood } from '../profiles/neighbourhoods';
import { Profile } from '../users/entities/profile.entity';
import {
  BarterCategory,
  BarterListing,
  BarterListingStatus,
  BarterMode,
} from './entities/barter-listing.entity';
import {
  BarterProposal,
  BarterProposalStatus,
} from './entities/barter-proposal.entity';

/**
 * Wire shapes for the skill exchange. Hand-mapped from the entities — there is
 * no global serializer in this codebase, so a column added later can never leak
 * by accident (see the API-response-mapping notes).
 *
 * The field names deliberately match the frontend's existing `Barter` fixture
 * (`features/economy/barter.data.ts`) so the board and detail page render a
 * live listing without being redesigned: `offer`, `want`, `offerDetail`,
 * `wantDetail`, `tags`, `category`, `mode`. What the fixture flattens into
 * loose `name`/`initials`/`tint` fields becomes a single `member` ref here,
 * which the frontend adapter expands.
 */
/**
 * The listing owner as a barter card shows them: the shared `MemberRef` plus
 * the neighbourhood the board renders under their name.
 *
 * `hood` lives here rather than on `MemberRef` because `MemberRef` is the
 * cross-domain compact ref every other surface embeds (feed authors, event
 * hosts, vouchers) and none of those render a neighbourhood — widening the
 * shared shape would push a location field onto all of them.
 *
 * GATED on the member's own `hoodVisible` toggle, mirroring `gateLocation` /
 * `MemberCard.hood` in `profiles/profile-response.ts`: a member who has hidden
 * their neighbourhood must not have it leak out through a barter card. Like
 * `toMemberRef`'s `photoVisible` gate there is deliberately NO owner-self
 * exception — these refs carry no viewer identity, so a hidden hood is hidden
 * on this surface even from its own member (they still see it on their own
 * profile, which uses the `isOwner`-aware `gateLocation`).
 */
export interface BarterMemberRef extends MemberRef {
  hood: string | null;
}

export interface BarterListingDTO {
  id: string;
  member: BarterMemberRef | null;
  category: BarterCategory;
  mode: BarterMode;
  offer: string;
  want: string;
  offerDetail: string;
  wantDetail: string;
  tags: string[];
  status: BarterListingStatus;
  /** True when the reader owns this listing, so the UI can offer the owner's
   *  view instead of a propose form it would refuse anyway. */
  isOwner: boolean;
  /** True when the reader already has a proposal on this listing. */
  hasProposed: boolean;
  /** ISO 8601. The board derives its "posted N days ago" label from this. */
  createdAt: string;
}

/** An owner-facing summary of one of your own listings. */
export interface MyBarterListingDTO extends BarterListingDTO {
  pendingProposalCount: number;
}

/**
 * A proposal as its listing's owner sees it. The proposer is a `MemberRef`, so
 * the raw `proposer_id` never crosses the wire; the message is included because
 * the owner is its intended recipient (it is also in their inbox).
 */
export interface BarterProposalDTO {
  id: string;
  listingId: string;
  proposer: MemberRef | null;
  message: string;
  status: BarterProposalStatus;
  decidedAt: string | null;
  createdAt: string;
}

/**
 * What `POST /barter/:id/proposals` returns. `conversationId` is the DM thread
 * the proposal was delivered into, so the client can deep-link straight to it
 * — `null` only when delivery failed after the proposal itself committed.
 */
export interface BarterProposalAckDTO {
  proposal: BarterProposalDTO;
  conversationId: string | null;
}

/**
 * A profile row mapped to the barter card's owner ref, hood included.
 *
 * Takes the whole `Profile` rather than a ready-made `MemberRef` on purpose:
 * `hoodVisible` and `location` only exist on the row, so building the ref and
 * its hood off the SAME row is what keeps this to one query per batch instead
 * of a second lookup per card (see `BarterService.ownerRefs`).
 */
export function toBarterMemberRef(
  profile: Profile | undefined | null,
): BarterMemberRef | null {
  const ref = toMemberRef(profile);
  if (!ref || !profile) return null;
  return {
    ...ref,
    hood: profile.hoodVisible ? matchNeighbourhood(profile.location) : null,
  };
}

export function toBarterListingDTO(
  listing: BarterListing,
  options: {
    member: BarterMemberRef | null;
    isOwner: boolean;
    hasProposed: boolean;
  },
): BarterListingDTO {
  return {
    id: listing.id,
    member: options.member,
    category: listing.category,
    mode: listing.mode,
    offer: listing.offer,
    want: listing.want,
    offerDetail: listing.offerDetail,
    wantDetail: listing.wantDetail,
    tags: listing.tags,
    status: listing.status,
    isOwner: options.isOwner,
    hasProposed: options.hasProposed,
    createdAt: listing.createdAt.toISOString(),
  };
}

export function toMyBarterListingDTO(
  listing: BarterListing,
  options: { member: BarterMemberRef | null; pendingProposalCount: number },
): MyBarterListingDTO {
  return {
    ...toBarterListingDTO(listing, {
      member: options.member,
      isOwner: true,
      hasProposed: false,
    }),
    pendingProposalCount: options.pendingProposalCount,
  };
}

export function toBarterProposalDTO(
  proposal: BarterProposal,
  proposer: MemberRef | null,
): BarterProposalDTO {
  return {
    id: proposal.id,
    listingId: proposal.listingId,
    proposer,
    message: proposal.message,
    status: proposal.status,
    decidedAt: proposal.decidedAt ? proposal.decidedAt.toISOString() : null,
    createdAt: proposal.createdAt.toISOString(),
  };
}
