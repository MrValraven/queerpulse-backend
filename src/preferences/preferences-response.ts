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
  skills: string[];
  focusAreas: string[];
}

export interface PublicProfileDTO {
  enabled: boolean;
}

/** `GET|PUT /me/login-alerts` — the sign-in-alert switch, on its own. */
export interface LoginAlertsDTO {
  enabled: boolean;
}

/**
 * `GET|PUT /me/push-previews`: the lock-screen-preview switch, on its own.
 *
 * `hidePreviews`, not `enabled`: this endpoint pair and the DTO behind it are
 * the authority the composer reads before it decides whether a push may carry
 * a sender's name, so the field has to read the same way to everyone.
 */
export interface PushPreviewsDTO {
  hidePreviews: boolean;
}

export function toWorkPreferencesDTO(
  row: MemberPreferences,
): WorkPreferencesDTO {
  return {
    outAtWork: row.outAtWork,
    transSupport: row.transSupport,
    safeOnly: row.safeOnly,
    skills: row.skills,
    focusAreas: row.focusAreas,
  };
}

export function toPublicProfileDTO(row: MemberPreferences): PublicProfileDTO {
  return { enabled: row.publicProfileEnabled };
}

export function toLoginAlertsDTO(row: MemberPreferences): LoginAlertsDTO {
  return { enabled: row.loginAlertsEnabled };
}

export function toPushPreviewsDTO(row: MemberPreferences): PushPreviewsDTO {
  return { hidePreviews: row.hidePushPreviews };
}
