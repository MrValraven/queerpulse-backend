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

/**
 * `GET|PUT /me/content-sensitivity` (PRD-10): the three feed filters, on their
 * own.
 *
 * `hide*` throughout, so the value means the same thing on the wire, in the
 * column and in the feed query. The Interests pane's checkbox reads the other
 * way round ("show me this"), and that single inversion lives at the render
 * site beside the label.
 */
export interface ContentSensitivityDTO {
  hideDating: boolean;
  hideMentalHealth: boolean;
  hideSexualityIdentity: boolean;
}

/**
 * `GET|PUT /me/suggestion-visibility` (PRD-16): the "stop recommending me to
 * strangers" switch, on its own.
 *
 * One-directional by design. It governs whether this member is offered to
 * OTHER people, never whether they are offered other people.
 */
export interface SuggestionVisibilityDTO {
  hideFromSuggestions: boolean;
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

export function toContentSensitivityDTO(
  row: MemberPreferences,
): ContentSensitivityDTO {
  return {
    hideDating: row.hideDatingContent,
    hideMentalHealth: row.hideMentalHealthContent,
    hideSexualityIdentity: row.hideSexualityIdentityContent,
  };
}

export function toSuggestionVisibilityDTO(
  row: MemberPreferences,
): SuggestionVisibilityDTO {
  return { hideFromSuggestions: row.hideFromSuggestions };
}
