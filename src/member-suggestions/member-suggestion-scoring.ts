import type { OpenToEntry } from '../profiles/open-to';

/**
 * How `GET /members/suggested` decides which people to put in front of a
 * member (SOC-05).
 *
 * WHAT THIS IS NOT. There is no behavioural tracking anywhere behind it, and
 * there is no engagement optimisation. Nothing counts opens, clicks, dwell,
 * profile views or "members who viewed X also viewed Y". This is the same
 * hard product rule the feed's ranking works under, and the reasoning there
 * applies verbatim here: see `src/feed/feed-affinity.ts`. The only inputs are
 * facts the member created ON PURPOSE and can undo at any time:
 *
 *   - they joined a community, and so did the candidate;
 *   - they accepted connections who have themselves accepted the candidate;
 *   - they wrote an "open to" chip, an interest tag, a profession or a
 *     language on their own profile, and so did the candidate.
 *
 * WHY IDENTITY IS NOT A SIGNAL. `profiles.discoverable_identities` is
 * special-category data about a person's queerness. It is opt-in, but the
 * consent it carries is narrow: it makes a member findable by someone who
 * deliberately ran an identity filter in the directory
 * (`GET /members?identities=`). A suggestion strip is the opposite motion. It
 * pushes a person, unasked, in front of a stranger, and this module's whole
 * contract is that the card SAYS WHY. Printing "you are both non-binary" to
 * someone who never asked would out a member through a surface they never
 * opted into, so identity is excluded outright rather than gated. Interest
 * tags, availability chips and professions carry the same "we have something
 * in common" value with none of that risk.
 *
 * WHY EVERY SUGGESTION IS EXPLAINABLE. A candidate with no matching fact
 * scores zero and is never suggested, so there is no "recommended for you"
 * case: every card carries the single strongest fact behind it
 * ({@link SuggestionReason}), and a member who dislikes a suggestion can find
 * the exact roster row, connection or self-written word responsible.
 */

/** The single fact that put a person in the strip. Precedence is the order
 *  below: the strongest matching fact wins. */
export type SuggestionReasonKind =
  'community' | 'mutuals' | 'openTo' | 'tag' | 'profession';

/**
 * The reason, in a shape the client can translate rather than a sentence the
 * server wrote. `label` is member/community data (a community name, a custom
 * "open to" phrase, an interest tag) and stays in the language it was
 * written in; `presetId` is set instead when the label is a shared vocabulary
 * id the client already translates (`members:openTo.*`). `count` carries the
 * mutual-connection total.
 */
export interface SuggestionReason {
  kind: SuggestionReasonKind;
  label: string | null;
  presetId: string | null;
  count: number;
}

/**
 * Weights. Deliberately small integers, in the same spirit (and roughly the
 * same order) as `feed-affinity.ts`.
 *
 * A shared room outranks a shared connection because it is the more durable
 * statement and, more to the point, the more verifiable one: the member can
 * open the community and see the person on the roster. Mutual connections
 * come next, the classic "you might know them" signal. The three
 * self-written facts are the weakest, because a word two people both typed is
 * the thinnest kind of tie.
 */
export const SCORE_SHARED_COMMUNITY = 3;
export const SCORE_MUTUAL_CONNECTIONS = 2;
export const SCORE_SHARED_OPEN_TO = 1;
export const SCORE_SHARED_TAG = 1;
export const SCORE_SHARED_PROFESSION = 1;

/**
 * A shared language scores, but can never be the reason a person is
 * suggested (see {@link ANCHORING_KINDS}). In a network centred on Lisbon
 * almost everyone shares Portuguese, so "you both speak Portuguese" explains
 * nothing and would drag half the directory into the strip. It is a
 * tie-breaker among people who already have a real tie, and nothing more.
 */
export const SCORE_SHARED_LANGUAGE = 1;

/**
 * The facts that can stand alone. A candidate matching ONLY refining facts
 * (today: language) scores zero and is dropped, because the card would have
 * nothing honest to say on it.
 */
export const ANCHORING_KINDS: readonly SuggestionReasonKind[] = [
  'community',
  'mutuals',
  'openTo',
  'tag',
  'profession',
];

/**
 * What the viewer's own graph and profile contribute. Resolved once per
 * request, never per candidate.
 */
export interface ViewerAffinity {
  /** Communities the viewer is on the roster of, whose roster is visible to
   *  them. A community with `roster_visible = false` is deliberately absent:
   *  see {@link CandidateAffinity.sharedCommunities}. */
  communityNamesById: Map<string, string>;
  /** Users the viewer has an ACCEPTED connection with, in either direction. */
  connectionUserIds: Set<string>;
  /** The viewer's own "open to" chips. */
  openTo: OpenToEntry[];
  /** Lower-cased for comparison; the display copy comes from the candidate. */
  tags: Set<string>;
  professions: Set<string>;
  languages: Set<string>;
}

export const EMPTY_VIEWER_AFFINITY: ViewerAffinity = {
  communityNamesById: new Map<string, string>(),
  connectionUserIds: new Set<string>(),
  openTo: [],
  tags: new Set<string>(),
  professions: new Set<string>(),
  languages: new Set<string>(),
};

/** True when the viewer has written and joined nothing this module can read.
 *  Scoring is skipped entirely for them: there is no honest suggestion to
 *  make, and the strip renders nothing rather than a guess. */
export function isEmptyAffinity(viewer: ViewerAffinity): boolean {
  return (
    viewer.communityNamesById.size === 0 &&
    viewer.connectionUserIds.size === 0 &&
    viewer.openTo.length === 0 &&
    viewer.tags.size === 0 &&
    viewer.professions.size === 0 &&
    viewer.languages.size === 0
  );
}

/** The candidate side of the comparison. Everything here is a fact the
 *  candidate created about themselves. */
export interface CandidateAffinity {
  /** Roster rows this candidate holds in the viewer's own communities. Only
   *  roster-visible communities reach this list, so a suggestion never
   *  reveals a membership the viewer could not already look up. */
  communityIds: string[];
  /** Accepted connections shared with the viewer. */
  mutualConnectionCount: number;
  /** The candidate's "open to" chips, ALREADY GATED by the caller: the
   *  directory only exposes `openTo` on an `open` profile, so a `network` or
   *  `private` candidate arrives here with an empty list and can never be
   *  explained by a chip the viewer is not allowed to see. */
  openTo: OpenToEntry[];
  tags: string[];
  professions: string[];
  languages: string[];
}

export interface SuggestionScore {
  score: number;
  reason: SuggestionReason | null;
  /** Kept for the sort's tie-breakers, which prefer the person with more
   *  mutual connections and then more shared rooms. Neither is a popularity
   *  measure across the platform: both are counted only against the viewer's
   *  own graph. */
  mutualConnectionCount: number;
  sharedCommunityCount: number;
}

const NOT_SUGGESTED: SuggestionScore = {
  score: 0,
  reason: null,
  mutualConnectionCount: 0,
  sharedCommunityCount: 0,
};

/** Case-insensitive, whitespace-trimmed overlap between a viewer set and a
 *  candidate list. Returns the candidate's own spelling, so the card shows
 *  the word the way it was written rather than a normalised form. */
function firstOverlap(
  viewerValues: Set<string>,
  candidateValues: string[],
): string | null {
  for (const value of candidateValues) {
    if (viewerValues.has(value.trim().toLowerCase())) {
      return value;
    }
  }
  return null;
}

/** The shared "open to" entry, preferring a preset (which the client can
 *  translate) over a custom phrase. Customs match case-insensitively, the
 *  same way the directory de-duplicates them. */
function sharedOpenTo(
  viewerEntries: OpenToEntry[],
  candidateEntries: OpenToEntry[],
): OpenToEntry | null {
  const viewerPresetIds = new Set(
    viewerEntries.flatMap((entry) =>
      entry.kind === 'preset' ? [entry.id as string] : [],
    ),
  );
  const viewerCustoms = new Set(
    viewerEntries.flatMap((entry) =>
      entry.kind === 'custom' ? [entry.label.trim().toLowerCase()] : [],
    ),
  );
  const preset = candidateEntries.find(
    (entry) => entry.kind === 'preset' && viewerPresetIds.has(entry.id),
  );
  if (preset) return preset;
  return (
    candidateEntries.find(
      (entry) =>
        entry.kind === 'custom' &&
        viewerCustoms.has(entry.label.trim().toLowerCase()),
    ) ?? null
  );
}

/**
 * One candidate's score, plus the single fact to show the member.
 *
 * Additive, so someone who is BOTH in your community and connected to three
 * of your connections outranks someone who is only one of the two, while
 * `reason` still names the strongest single match rather than a vague blend.
 * A candidate with no anchoring fact scores zero and carries no reason, which
 * is the caller's signal to drop them.
 */
export function scoreSuggestion(
  viewer: ViewerAffinity,
  candidate: CandidateAffinity,
): SuggestionScore {
  const sharedCommunityId =
    candidate.communityIds.find((communityId) =>
      viewer.communityNamesById.has(communityId),
    ) ?? null;
  const sharedCommunityCount = candidate.communityIds.filter((communityId) =>
    viewer.communityNamesById.has(communityId),
  ).length;
  const mutualConnectionCount = Math.max(0, candidate.mutualConnectionCount);
  const openToEntry = sharedOpenTo(viewer.openTo, candidate.openTo);
  const sharedTag = firstOverlap(viewer.tags, candidate.tags);
  const sharedProfession = firstOverlap(
    viewer.professions,
    candidate.professions,
  );
  const sharedLanguage = firstOverlap(viewer.languages, candidate.languages);

  const score =
    (sharedCommunityId ? SCORE_SHARED_COMMUNITY : 0) +
    (mutualConnectionCount > 0 ? SCORE_MUTUAL_CONNECTIONS : 0) +
    (openToEntry ? SCORE_SHARED_OPEN_TO : 0) +
    (sharedTag ? SCORE_SHARED_TAG : 0) +
    (sharedProfession ? SCORE_SHARED_PROFESSION : 0) +
    (sharedLanguage ? SCORE_SHARED_LANGUAGE : 0);

  const reason = ((): SuggestionReason | null => {
    if (sharedCommunityId) {
      return {
        kind: 'community',
        label: viewer.communityNamesById.get(sharedCommunityId) ?? null,
        presetId: null,
        count: sharedCommunityCount,
      };
    }
    if (mutualConnectionCount > 0) {
      return {
        kind: 'mutuals',
        label: null,
        presetId: null,
        count: mutualConnectionCount,
      };
    }
    if (openToEntry) {
      return {
        kind: 'openTo',
        label: openToEntry.kind === 'custom' ? openToEntry.label : null,
        presetId: openToEntry.kind === 'preset' ? openToEntry.id : null,
        count: 0,
      };
    }
    if (sharedTag) {
      return { kind: 'tag', label: sharedTag, presetId: null, count: 0 };
    }
    if (sharedProfession) {
      return {
        kind: 'profession',
        label: sharedProfession,
        presetId: null,
        count: 0,
      };
    }
    return null;
  })();

  // No anchoring fact means nothing honest to print on the card, so the
  // candidate is dropped whatever the refining facts added.
  if (!reason) return NOT_SUGGESTED;

  return { score, reason, mutualConnectionCount, sharedCommunityCount };
}

/**
 * Strongest first. Ties break on mutual connections, then on how many of the
 * viewer's rooms the person shares, then on the caller's stable fallback
 * (newest member first), so the order never depends on row arrival.
 *
 * The tie-breakers are the one place a count influences position, and both
 * counts are measured against the VIEWER's own graph. Neither is a global
 * follower count, so a well-known member gets no platform-wide boost.
 */
export function compareSuggestions(
  first: SuggestionScore,
  second: SuggestionScore,
): number {
  if (second.score !== first.score) return second.score - first.score;
  if (second.mutualConnectionCount !== first.mutualConnectionCount) {
    return second.mutualConnectionCount - first.mutualConnectionCount;
  }
  return second.sharedCommunityCount - first.sharedCommunityCount;
}
