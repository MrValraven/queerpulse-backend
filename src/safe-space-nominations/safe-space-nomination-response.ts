import type { SafeSpaceNomination } from './entities/safe-space-nomination.entity';

/**
 * Client-facing shape of a nomination. Hand-mapped from the entity (this
 * codebase has no global serializer) so a column added to the table never
 * leaks onto the wire by accident.
 */
export interface SafeSpaceNominationResponse {
  id: string;
  placeName: string;
  address: string | null;
  placeType: string | null;
  listingRef: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
}

/** Admin list row — the client shape plus who submitted it. */
export interface AdminSafeSpaceNominationResponse extends SafeSpaceNominationResponse {
  nominatorId: string;
}

export function toSafeSpaceNominationResponse(
  nomination: SafeSpaceNomination,
): SafeSpaceNominationResponse {
  return {
    id: nomination.id,
    placeName: nomination.placeName,
    address: nomination.address,
    placeType: nomination.placeType,
    listingRef: nomination.listingRef,
    reason: nomination.reason,
    status: nomination.status,
    createdAt: nomination.createdAt.toISOString(),
  };
}

export function toAdminSafeSpaceNominationResponse(
  nomination: SafeSpaceNomination,
): AdminSafeSpaceNominationResponse {
  return {
    ...toSafeSpaceNominationResponse(nomination),
    nominatorId: nomination.nominatorId,
  };
}
