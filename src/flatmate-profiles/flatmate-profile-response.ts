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
  /**
   * Whether the viewer and this profile's owner have liked each other, which is
   * what `matches` visibility now requires (ENG-51). Resolved by the caller
   * through `FlatmateLikesService.mutuallyMatchedProfileIds`, batched across a
   * whole page, so this stays a plain boolean and the gate stays synchronous.
   *
   * Fail closed: pass `false` when the answer is unknown or was not looked up.
   */
  hasMutualMatch: boolean;
  /**
   * True when the profile is being serialized into a LIST payload (the board
   * browse) rather than its own detail response.
   *
   * A list withholds the Art.9 fields of profiles set to `matches` (ENG-51),
   * and only those. That setting is the one the finding was about, so belt and
   * braces there: even if the gate above is later widened or breaks, harvesting
   * `matches` profiles costs one request each instead of twenty at a time.
   *
   * `public` and `members` are honoured on the list, because they are an
   * explicit, informed choice by the owner to be visible to any member, and the
   * grid cards and the discovery deck are exactly where that choice does its
   * work. Overriding it there would be paternalism dressed as a safeguard, and
   * it protects nobody: those profiles reveal to every viewer on the detail
   * page anyway, so stripping the list costs the owner reach and costs an
   * attacker one extra hop.
   */
  isListSurface: boolean;
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
 *
 * `matches` requires an actual mutual match (ENG-51). It used to mean "the
 * viewer holds a profile whose `type` differs from this one", which sounds like
 * a narrowing rule and is not one: `type` is a field the viewer sets on their
 * OWN profile, so any member could flip it and read the consenting half of the
 * other side of the board in bulk through `GET /flatmates`, with no like, no
 * match and no contact. The on-screen label read "Only people I could share a
 * home with", which no member would understand as "everyone looking for the
 * opposite of what I am", so the setting was collecting consent it did not
 * honour. The gate now means what the label implies, and the label was
 * rewritten to "Only people I have matched with" to say it outright.
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
      // An actual match, both directions, resolved by the caller. Deliberately
      // NOT "the viewer's type differs from this profile's": see the note above
      // this function for why that was not a gate at all.
      return context.hasMutualMatch;
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
  const visibility = profile.identityVisibility ?? IdentityVisibility.Matches;
  const isPermittedViewer = canRevealIdentity(profile, context);
  // The gate decides WHETHER this viewer may see the Art.9 fields; the surface
  // decides whether this RESPONSE is a place to put them (ENG-51). Both must
  // hold.
  //
  // Today this is belt and braces: `mapRows` passes `hasMutualMatch: false`, so
  // a `matches` profile fails the gate on a list regardless. It is written out
  // anyway so that a future caller which DOES resolve matches for a list cannot
  // silently turn the board back into a bulk read of the thing this finding was
  // about. The owner is exempt because their own management reads go through
  // this mapper too, and withholding a member's own data from them would be a
  // bug, not a safeguard.
  const isWithheldByListSurface =
    context.isListSurface &&
    !context.isOwner &&
    visibility === IdentityVisibility.Matches;
  const reveal = isPermittedViewer && !isWithheldByListSurface;
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
    identityVisibility: visibility,
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
