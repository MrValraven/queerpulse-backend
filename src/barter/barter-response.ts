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
 * The listing as the member who PROPOSED on it needs to recognise it: enough
 * to know which swap this was, who posted it, and whether it still stands.
 *
 * Deliberately narrower than {@link BarterListingDTO}. `isOwner` is always
 * false here by construction (you cannot propose on your own listing) and
 * `hasProposed` is always true, so neither carries information; the long
 * `offerDetail`/`wantDetail` bodies belong on the listing page the row links
 * to rather than in a list of a member's own sent offers.
 */
export interface ProposedBarterListingDTO {
  id: string;
  member: BarterMemberRef | null;
  category: BarterCategory;
  mode: BarterMode;
  offer: string;
  want: string;
  status: BarterListingStatus;
}

/**
 * A proposal as the member who SENT it sees it (`GET /barter/mine/proposals`).
 *
 * Before this the proposer had no view of their own offers at all: a proposal
 * left for the owner's inbox and never came back. `status` and `decidedAt` are
 * the outcome; `listing` is what the outcome was about.
 *
 * What is NOT here is as deliberate as what is. There is no owner-written
 * reasoning field on the schema and none is added: an owner's answer is
 * accept or decline, and anything they want to say about it goes in the DM
 * thread the proposal opened, in their own words to one person. `message` IS
 * returned because the proposer wrote it and is reading their own text back.
 */
export interface MySentBarterProposalDTO {
  id: string;
  listingId: string;
  listing: ProposedBarterListingDTO | null;
  message: string;
  status: BarterProposalStatus;
  decidedAt: string | null;
  createdAt: string;
  /**
   * True when the poster materially changed the listing (category, mode, or
   * either headline) AFTER this proposal was sent. The proposer offered
   * against what the post said at the time, so the surface says so plainly
   * rather than letting the deal quietly become a different one. See
   * `BarterListing.materialEditedAt`.
   */
  wasListingEditedAfterProposal: boolean;
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

/** A listing mapped down to what the proposer's own row needs to show. */
export function toProposedBarterListingDTO(
  listing: BarterListing,
  member: BarterMemberRef | null,
): ProposedBarterListingDTO {
  return {
    id: listing.id,
    member,
    category: listing.category,
    mode: listing.mode,
    offer: listing.offer,
    want: listing.want,
    status: listing.status,
  };
}

/**
 * One of the caller's own sent proposals.
 *
 * `listing` is `null` when the post is gone (deleted with its poster's
 * account) or when the two members have since blocked each other. The row
 * itself is still returned: it is the proposer's own record of something they
 * sent, and dropping it would make their history silently incomplete.
 */
export function toMySentBarterProposalDTO(
  proposal: BarterProposal,
  listing: ProposedBarterListingDTO | null,
  materialEditedAt: Date | null,
): MySentBarterProposalDTO {
  return {
    id: proposal.id,
    listingId: proposal.listingId,
    listing,
    message: proposal.message,
    status: proposal.status,
    decidedAt: proposal.decidedAt ? proposal.decidedAt.toISOString() : null,
    createdAt: proposal.createdAt.toISOString(),
    wasListingEditedAfterProposal: Boolean(
      materialEditedAt && materialEditedAt > proposal.createdAt,
    ),
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
