import { MemberRef } from '../common/member-ref';
import { VerificationLevel } from '../verification/verification-level';
import {
  FlatmateHouseholdNorms,
  FlatmateIdentityHousehold,
  FlatmateProfile,
  FlatmateProfileType,
  IdentityVisibility,
} from './entities/flatmate-profile.entity';
import { MatchReason, MatchResult } from './flatmate-match';

/**
 * Describes the viewer a profile is being serialized for, so the mapper can
 * decide whether to reveal the GDPR Art.9 special-category identity fields.
 */
export interface IdentityViewContext {
  /** The viewer is the profile's owner — always sees their own data. */
  isOwner: boolean;
  /** The viewer's own flatmate-profile type, or null if they have no profile.
   * Only used to resolve `matches` (opposite-side) visibility. */
  viewerProfileType: FlatmateProfileType | null;
}

/** Wire shape for a flatmate profile. `member` is the compact identity ref;
 * `matchScore` is present on the member browse (relative to the viewer's own
 * profile, opposite type) and `null` otherwise.
 *
 * The special-category fields (`pronouns`, `genderIdentity`, `safeSpaceNeeds`)
 * are only populated for a permitted viewer — otherwise they come back empty so
 * nothing leaks in list/preview payloads. `specialCategoryConsent` is only ever
 * truthful to the owner (others always see `false`). */
export interface FlatmateProfileDTO {
  slug: string;
  type: FlatmateProfileType;
  member: MemberRef | null;
  /** The owner's REAL identity-verification level — powers an honest badge on
   * the flatmate card/detail. Reflects a recorded verification event (or the
   * `email` floor), never a self-asserted flag. */
  verificationLevel: VerificationLevel;
  pronouns: string;
  neighbourhood: string;
  budgetEuros: number;
  moveInFrom: string | null;
  flexibleTiming: boolean;
  about: string;
  lifestyleTags: string[];
  genderIdentity: string | null;
  safeSpaceNeeds: string[];
  householdNorms: FlatmateHouseholdNorms | null;
  /** Consent-gated trans-affirming household prompts (Art.9). Only populated for
   * a permitted viewer — otherwise `null`. */
  identityHousehold: FlatmateIdentityHousehold | null;
  identityVisibility: IdentityVisibility;
  /** Whether the owner has granted Art.9 consent. Owner-only signal (false for
   * everyone else) — powers the form's consent checkbox on edit. */
  specialCategoryConsent: boolean;
  createdAt: string;
  matchScore: number | null;
  /** Explainable "why you matched" factors. Already GDPR-redacted by the match
   * engine (generic safe-space label for non-permitted viewers). Empty unless
   * this is a scored opposite-type browse/detail result. */
  matchReasons: MatchReason[];
}

/**
 * The one place identity gating is decided. Returns true only when the viewer
 * is allowed to see the special-category fields: the owner always; otherwise
 * only if consent is on the record AND the visibility setting admits them.
 */
export function canRevealIdentity(
  profile: FlatmateProfile,
  context: IdentityViewContext,
): boolean {
  if (context.isOwner) return true;
  if (!profile.specialCategoryConsentAt) return false;
  const visibility = profile.identityVisibility ?? IdentityVisibility.Matches;
  switch (visibility) {
    case IdentityVisibility.Public:
    case IdentityVisibility.Members:
      // Every viewer of these member-only endpoints is already an active
      // member, so both audiences resolve the same way here.
      return true;
    case IdentityVisibility.Matches:
      return (
        context.viewerProfileType !== null &&
        context.viewerProfileType !== profile.type
      );
    case IdentityVisibility.Hidden:
      return false;
    default:
      return false;
  }
}

export function toFlatmateProfileDTO(
  profile: FlatmateProfile,
  member: MemberRef | null,
  match: MatchResult | null,
  context: IdentityViewContext,
  verificationLevel: VerificationLevel,
): FlatmateProfileDTO {
  const reveal = canRevealIdentity(profile, context);
  return {
    slug: profile.slug,
    type: profile.type,
    member,
    verificationLevel,
    // Special-category — only for a permitted viewer.
    pronouns: reveal ? profile.pronouns : '',
    neighbourhood: profile.neighbourhood,
    budgetEuros: profile.budgetEuros,
    moveInFrom: profile.moveInFrom,
    flexibleTiming: profile.flexibleTiming,
    about: profile.about,
    lifestyleTags: profile.lifestyleTags,
    genderIdentity: reveal ? (profile.genderIdentity ?? null) : null,
    safeSpaceNeeds: reveal ? (profile.safeSpaceNeeds ?? []) : [],
    householdNorms: profile.householdNorms ?? null,
    // Consent-gated: null unless this viewer is permitted.
    identityHousehold: reveal ? (profile.identityHousehold ?? null) : null,
    identityVisibility:
      profile.identityVisibility ?? IdentityVisibility.Matches,
    specialCategoryConsent:
      context.isOwner && profile.specialCategoryConsentAt !== null,
    createdAt: profile.createdAt.toISOString(),
    matchScore: match?.score ?? null,
    // Reasons are pre-redacted by the engine; the match was scored with this
    // viewer's reveal permission, so safe-space specifics only appear here when
    // the viewer is allowed to see them.
    matchReasons: match?.reasons ?? [],
  };
}
