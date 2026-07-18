import {
  MemberPreferences,
  OutAtWork,
} from './entities/member-preferences.entity';

// Response shapes are the frontend contract exactly — the two endpoints project
// disjoint subsets of the one row, so neither leaks the other's settings.
export interface WorkPreferencesDTO {
  outAtWork: OutAtWork;
  transSupport: string[];
  safeOnly: boolean;
}

export interface PublicProfileDTO {
  enabled: boolean;
}

export function toWorkPreferencesDTO(
  row: MemberPreferences,
): WorkPreferencesDTO {
  return {
    outAtWork: row.outAtWork,
    transSupport: row.transSupport,
    safeOnly: row.safeOnly,
  };
}

export function toPublicProfileDTO(row: MemberPreferences): PublicProfileDTO {
  return { enabled: row.publicProfileEnabled };
}
