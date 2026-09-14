import type { OpenToEntry } from './open-to';

/**
 * Why a "People close by" card is close to the PROFILE OWNER. The card sits
 * on someone else's profile, so "Both in X" means the owner and the card's
 * member, and the same card therefore reads identically for every viewer. A
 * viewer-relative variant of this would be a different feature (see the
 * connect surface's "People you might know", which is viewer-relative by
 * design).
 *
 * The wire carries a TOKEN plus the one name it needs. The frontend owns the
 * EN/PT wording, because a backend-authored phrase would be untranslatable the
 * moment it left this file.
 */
export type RelatedClosenessKind =
  /** This member vouched for the profile owner. */
  | 'vouchedForOwner'
  /** The profile owner vouched for this member. */
  | 'ownerVouchedFor'
  /** Both sit on the same community roster. `value` is the community name. */
  | 'community'
  /** Both listed the same "Open to" preset. `value` is the preset id. */
  | 'openToPreset'
  /** Both wrote the same custom "Open to" chip. `value` is that label. */
  | 'openToCustom'
  /** Both listed the same craft tag. `value` is the tag. */
  | 'craft'
  /** Both give the same neighbourhood. `value` is it. */
  | 'hood';

export interface RelatedCloseness {
  kind: RelatedClosenessKind;
  /** The community name / preset id / label / tag / neighbourhood the kind
   *  names, or `null` for the two vouch kinds, which name nobody but the two
   *  people already on the card. */
  value: string | null;
}

/** Every signal `pickCloseness` chooses between, already gated by its caller.
 *  A field is `null`/`false` when the signal is absent OR when the member
 *  whose data it would disclose has hidden it. This function never gates. */
export interface ClosenessSignals {
  vouchedForOwner: boolean;
  ownerVouchedFor: boolean;
  sharedCommunity: string | null;
  sharedOpenTo: OpenToEntry | null;
  sharedCraft: string | null;
  sharedHood: string | null;
}

/**
 * The single strongest reason, or `null` when every signal is absent or
 * hidden. Strength order, strongest first:
 *
 *   1. a vouch RECEIVED by the owner from this member: the only signal where
 *      someone put their own standing behind the other person,
 *   2. a vouch the owner GAVE them: the same act, ranked second only because
 *      the owner's page should lead with what others said about them,
 *   3. a shared community: chosen, named, and specific,
 *   4. a shared "Open to" chip: chosen, and about availability rather than
 *      belonging,
 *   5. a shared craft tag, then 6. a shared neighbourhood: these two are the
 *      rule that PUT the card in this list at all (see
 *      `ProfilesService.loadRelated`), so they are the floor rather than a
 *      finding, and craft outranks a neighbourhood because a city area is the
 *      weaker coincidence of the two.
 *
 * Exactly one chip renders per card, so ranking here is the whole decision.
 */
export function pickCloseness(
  signals: ClosenessSignals,
): RelatedCloseness | null {
  if (signals.vouchedForOwner) {
    return { kind: 'vouchedForOwner', value: null };
  }
  if (signals.ownerVouchedFor) {
    return { kind: 'ownerVouchedFor', value: null };
  }
  if (signals.sharedCommunity) {
    return { kind: 'community', value: signals.sharedCommunity };
  }
  if (signals.sharedOpenTo) {
    return signals.sharedOpenTo.kind === 'preset'
      ? { kind: 'openToPreset', value: signals.sharedOpenTo.id }
      : { kind: 'openToCustom', value: signals.sharedOpenTo.label };
  }
  if (signals.sharedCraft) {
    return { kind: 'craft', value: signals.sharedCraft };
  }
  if (signals.sharedHood) {
    return { kind: 'hood', value: signals.sharedHood };
  }
  return null;
}

/**
 * The first "Open to" entry both members listed, in the OWNER's chip order, or
 * `null`. Presets match by id; customs are the member's own words, so they
 * match case-insensitively after trimming ("Casual meetups" and "casual
 * meetups" are the same chip written twice).
 */
export function sharedOpenTo(
  ownerOpenTo: OpenToEntry[],
  theirOpenTo: OpenToEntry[],
): OpenToEntry | null {
  const theirPresets = new Set(
    theirOpenTo.filter((e) => e.kind === 'preset').map((e) => e.id),
  );
  const theirCustoms = new Set(
    theirOpenTo
      .filter((e) => e.kind === 'custom')
      .map((e) => e.label.trim().toLowerCase()),
  );
  for (const entry of ownerOpenTo) {
    if (entry.kind === 'preset' && theirPresets.has(entry.id)) {
      return entry;
    }
    if (
      entry.kind === 'custom' &&
      theirCustoms.has(entry.label.trim().toLowerCase())
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * The first craft tag both members listed, in the OWNER's tag order, matched
 * case-insensitively. The owner's spelling is the one returned: it is the
 * page the chip renders on.
 */
export function sharedCraft(
  ownerTags: string[],
  theirTags: string[],
): string | null {
  const theirs = new Set(theirTags.map((tag) => tag.trim().toLowerCase()));
  return ownerTags.find((tag) => theirs.has(tag.trim().toLowerCase())) ?? null;
}

/**
 * Everything `closenessFor` needs about ONE related card, with each side's
 * privacy toggles alongside the facts they govern. The two hoods arrive
 * ALREADY gated (`gateLocation`, plus the `open`-visibility layer for the
 * related member). A caller that has not run those gates must pass `null`
 * rather than a raw `location`.
 */
export interface ClosenessFacts {
  /** Whether the owner's voucher roster may be named at all. */
  ownerVouchersVisible: boolean;
  /** Whether the related member's voucher roster may be. */
  theirVouchersVisible: boolean;
  /** A live, non-anonymous vouch from the related member to the owner. */
  theyVouchedForOwner: boolean;
  /** ...and one the other way. */
  ownerVouchedForThem: boolean;
  /** A community both are on the visible roster of, already tier-checked. */
  sharedCommunity: string | null;
  /** The related member's profile visibility is `open`. `openTo` is theirs to
   *  disclose, so a `network`/`private` member contributes no chip from it. */
  theirProfileOpen: boolean;
  ownerOpenTo: OpenToEntry[];
  theirOpenTo: OpenToEntry[];
  /** Craft tags, ungated on both sides by design (see `ProfileCard.tags`). */
  ownerTags: string[];
  theirTags: string[];
  /** Both already gated; `null` means "hidden" and "unset" alike, which is
   *  the point: a chip can never tell those two apart. */
  ownerHood: string | null;
  theirHood: string | null;
}

/**
 * One card's chip: apply each side's privacy toggles, then rank what survives
 * (see `pickCloseness`). Gating happens here rather than in the ranking so
 * that a hidden strong signal falls through to a weaker visible one instead of
 * silently suppressing the card's chip altogether.
 */
export function closenessFor(facts: ClosenessFacts): RelatedCloseness | null {
  return pickCloseness({
    // "X vouched for <owner>" is a row on the OWNER's voucher roster, so the
    // owner's toggle governs whether it may be named...
    vouchedForOwner: facts.ownerVouchersVisible && facts.theyVouchedForOwner,
    // ...and "<owner> vouched for X" is a row on X's roster, so X's toggle
    // governs that one. Hiding your vouchers hides the chips that would have
    // named them one at a time.
    ownerVouchedFor: facts.theirVouchersVisible && facts.ownerVouchedForThem,
    sharedCommunity: facts.sharedCommunity,
    sharedOpenTo: facts.theirProfileOpen
      ? sharedOpenTo(facts.ownerOpenTo, facts.theirOpenTo)
      : null,
    sharedCraft: sharedCraft(facts.ownerTags, facts.theirTags),
    sharedHood:
      facts.ownerHood && facts.ownerHood === facts.theirHood
        ? facts.ownerHood
        : null,
  });
}
