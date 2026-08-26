import { Profile } from '../users/entities/profile.entity';
import { ProfileVisibility } from '../users/entities/profile.entity';
import { MemberCard, toMemberCard } from '../profiles/profile-response';
import type { SuggestionReason } from './member-suggestion-scoring';

/**
 * One person the strip can offer, and the single fact behind them (SOC-05).
 *
 * The card itself is the directory's own `MemberCard`, produced by the same
 * `toMemberCard` mapper `GET /members` uses. That is deliberate: a suggestion
 * must never expose one byte more about a member than the directory already
 * does, and sharing the mapper is the only way to guarantee that as the card
 * evolves. `activityBand` is passed as `null` here — this endpoint does not
 * ask for the last-active signal, which the DTO already documents as one of
 * the three cases the client renders as nothing at all.
 *
 * `reason` is a shape, never a sentence. The server never writes display
 * copy: the client owns the wording and the translation, and the member/
 * community data inside it (`label`) stays in whatever language it was
 * written in, exactly like every other name and tag on the platform.
 */
export interface SuggestedMember {
  member: MemberCard;
  reason: SuggestionReason;
  /** The additive score behind the ordering. Sent so the client can show a
   *  stable order without re-sorting, and so a future debug view has
   *  something to read; it is never rendered as a number to a member. */
  score: number;
}

export interface SuggestedMembersResponse {
  items: SuggestedMember[];
}

/**
 * The candidate's `openTo`, gated exactly the way the directory card gates it.
 *
 * `toMemberCard` blanks `openTo` on any profile that is not `open`, so a
 * suggestion explained by an availability chip must apply the same gate
 * BEFORE scoring. Otherwise the reason line would print a chip the member
 * chose to keep off their card, and the card next to it would show nothing to
 * back it up.
 */
export function visibleOpenTo(profile: Profile): Profile['openTo'] {
  return profile.visibility === ProfileVisibility.Open
    ? (profile.openTo ?? [])
    : [];
}

/**
 * Maps one scored candidate onto the wire.
 *
 * `vouchCount` comes from the profile's own denormalized column rather than a
 * batched `VouchService` lookup: the column is kept in sync inside the same
 * transaction as every vouch write, and reading it here keeps this module
 * from importing the vouch feature for a number it already has in hand.
 */
export function toSuggestedMember(
  profile: Profile,
  reason: SuggestionReason,
  score: number,
): SuggestedMember {
  return {
    // `isOwner` is hardcoded false: a viewer is never suggested to themself
    // (see `MemberSuggestionsService`'s self-exclusion), so the owner branch
    // of `gateAvatarUrl`/`gateLocation` is unreachable from this endpoint.
    member: toMemberCard(profile, profile.vouchCount ?? 0, false, null),
    reason,
    score,
  };
}
