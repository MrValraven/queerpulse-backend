import { MemberRef } from '../common/member-ref';
import {
  HousingViewing,
  HousingViewingMode,
  HousingViewingParty,
  HousingViewingStatus,
} from './entities/housing-viewing.entity';

/** timestamptz array/scalar can arrive as Date OR ISO string depending on the
 * driver path; normalize either to an ISO string for the wire. */
function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Wire shape for one viewing, ALWAYS rendered from the caller's perspective:
 * `role` is who the caller is on this viewing, and `counterparty` is the other
 * person. `youProposedLast` lets the client show the right action (accept the
 * other side's slots, or wait) without re-deriving the turn.
 */
export interface HousingViewingDTO {
  id: string;
  listingRef: string;
  listingSlug: string;
  listingTitle: string;
  role: HousingViewingParty;
  counterparty: MemberRef | null;
  mode: HousingViewingMode;
  status: HousingViewingStatus;
  proposedBy: HousingViewingParty;
  /** True when the caller made the proposal currently on the table — so they
   * wait on the other side rather than being offered an accept action. */
  youProposedLast: boolean;
  proposedSlots: string[];
  acceptedSlot: string | null;
  note: string;
  responseNote: string | null;
  /** True while the viewing is requested or accepted: either participant may
   * still call it off (ENG-467). A completed viewing stays on the record. */
  canCancel: boolean;
  /** True once an accepted viewing's agreed slot has come round, the same rule
   * `HousingViewingsService.complete` enforces (PRD-446), so the client offers
   * "Mark completed" only when the server will take it. */
  canComplete: boolean;
  /** True while the home can still be booked from the caller's side: live,
   * present, unfilled, unexpired, clear of a moderator takedown, and with no
   * block either way between the caller and the lister. The client offers
   * "Request another time" on a closed viewing only when this holds. */
  isListingOpen: boolean;
  /** True once the lister deleted the home. A completed viewing on a deleted
   * home has nothing left to review, while a filled home stays reviewable. */
  isListingDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListingSummary {
  ref: string;
  slug: string;
  title: string;
  /** See `HousingViewingDTO.isListingOpen`. */
  isOpen: boolean;
  /** See `HousingViewingDTO.isListingDeleted`. */
  isDeleted: boolean;
}

export function toHousingViewingDTO(
  viewing: HousingViewing,
  callerId: string,
  listing: ListingSummary,
  counterparty: MemberRef | null,
  now: number = Date.now(),
): HousingViewingDTO {
  const acceptedSlotMs = viewing.acceptedSlot
    ? new Date(viewing.acceptedSlot).getTime()
    : null;
  const role =
    viewing.requesterId === callerId
      ? HousingViewingParty.Requester
      : HousingViewingParty.Lister;
  return {
    id: viewing.id,
    listingRef: listing.ref,
    listingSlug: listing.slug,
    listingTitle: listing.title,
    role,
    counterparty,
    mode: viewing.mode,
    status: viewing.status,
    proposedBy: viewing.proposedBy,
    youProposedLast: viewing.proposedBy === role,
    proposedSlots: viewing.proposedSlots.map(toIso),
    acceptedSlot: viewing.acceptedSlot ? toIso(viewing.acceptedSlot) : null,
    note: viewing.note,
    responseNote: viewing.responseNote,
    canCancel:
      viewing.status === HousingViewingStatus.Requested ||
      viewing.status === HousingViewingStatus.Accepted,
    canComplete:
      viewing.status === HousingViewingStatus.Accepted &&
      acceptedSlotMs !== null &&
      acceptedSlotMs <= now,
    isListingOpen: listing.isOpen,
    isListingDeleted: listing.isDeleted,
    createdAt: toIso(viewing.createdAt),
    updatedAt: toIso(viewing.updatedAt),
  };
}
