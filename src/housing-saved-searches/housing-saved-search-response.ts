import { HousingSavedSearch } from './entities/housing-saved-search.entity';
import { HousingSearchCriteria } from './housing-search-criteria';

/**
 * Wire shape for one saved search. Hand-mapped (no global serializer) — the
 * member's own row, so `memberId` and timestamps beyond `createdAt` are simply
 * not echoed back.
 */
export interface HousingSavedSearchDTO {
  id: string;
  name: string;
  criteria: HousingSearchCriteria;
  alertsEnabled: boolean;
  createdAt: string;
}

export function toHousingSavedSearchDTO(
  search: HousingSavedSearch,
): HousingSavedSearchDTO {
  return {
    id: search.id,
    name: search.name,
    criteria: search.criteria,
    alertsEnabled: search.alertsEnabled,
    createdAt: search.createdAt.toISOString(),
  };
}
