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
  createdAt: string;
  updatedAt: string;
}

export interface ListingSummary {
  ref: string;
  slug: string;
  title: string;
}

export function toHousingViewingDTO(
  viewing: HousingViewing,
  callerId: string,
  listing: ListingSummary,
  counterparty: MemberRef | null,
): HousingViewingDTO {
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
    createdAt: toIso(viewing.createdAt),
    updatedAt: toIso(viewing.updatedAt),
  };
}
