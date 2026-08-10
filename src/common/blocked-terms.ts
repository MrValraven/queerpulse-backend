/**
 * Centrally-managed slur/hate-term screening list for member-authored identity
 * fields (persona display names, taglines/bios, handles). This is the SINGLE
 * source of truth so every feature that screens free text hits the same list
 * rather than keeping its own drifting copy — the two-item placeholder array
 * this replaces (`['slur-placeholder-1', 'slur-placeholder-2']`) did no real
 * screening at all.
 *
 * Design + deliberate limits:
 *  - **Word-boundary, case-insensitive matching** (see {@link textHasBlockedTerm}).
 *    Substring matching (the old `.includes()`) trips the Scunthorpe problem —
 *    innocuous words like "class", "assistant", "Scunthorpe" contain slur
 *    substrings. Boundary matching catches a slur used as a standalone word
 *    without those false positives.
 *  - **Hard, unambiguous-slur list — NOT a general profanity filter.** QueerPulse
 *    is a queer community platform: reclaimed in-community language ("queer",
 *    "dyke", "fag" used self-referentially) is intentionally absent, because a
 *    blanket profanity block would erase the community's own voice. Genuinely
 *    ambiguous or context-dependent cases belong in HUMAN moderation (report →
 *    `moderation` module), not this publish-time gate.
 *  - **Obfuscation (l33t, zero-width chars, spacing) is out of scope here** — an
 *    automated arms race that belongs, again, in reactive human moderation. This
 *    gate is the cheap first pass that stops the blatant cases at publish time.
 *  - Expand the list in ONE place and every consumer updates at once.
 */
export const BLOCKED_TERMS: readonly string[] = [
  // Anti-LGBTQ slurs (used as attacks — reclaimed self-reference is not screened
  // here; this gate only fires on the term as a standalone word).
  'faggot',
  'faggots',
  'tranny',
  'trannies',
  'shemale',
  'heshe',
  // Racial / ethnic slurs.
  'nigger',
  'niggers',
  'chink',
  'chinks',
  'spic',
  'spics',
  'kike',
  'kikes',
  'gook',
  'gooks',
  'coon',
  'wetback',
  'wetbacks',
  // Ableist slur.
  'retard',
  'retards',
  'retarded',
];

/** Escape a term for safe insertion into a RegExp character-class-free pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One compiled alternation, matched on word boundaries, case-insensitively. An
// empty list compiles to a pattern that can never match, so screening becomes a
// safe no-op rather than throwing.
const BLOCKED_TERMS_PATTERN: RegExp = BLOCKED_TERMS.length
  ? new RegExp(`\\b(?:${BLOCKED_TERMS.map(escapeRegExp).join('|')})\\b`, 'i')
  : /(?!)/;

/**
 * True when any of the supplied text fragments contains a blocked term as a
 * whole word (case-insensitive). Accepts several fragments so a caller can pass
 * e.g. a display name, bio, and handle in one call without pre-joining.
 */
export function textHasBlockedTerm(
  ...fragments: (string | null | undefined)[]
): boolean {
  const haystack = fragments.filter(Boolean).join(' ');
  return BLOCKED_TERMS_PATTERN.test(haystack);
}
