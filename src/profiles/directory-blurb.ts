/**
 * The blurb a member's directory card shows: their short bio (`tagline`),
 * falling back to the opening of their longer bio when they haven't written one.
 *
 * This rule is a CONTRACT SHARED WITH THE FRONTEND, whose half lives at
 * `src/features/members/directoryBlurb.ts`. Keep the two in step: the profile
 * editor renders a live preview of the member's own card using the frontend
 * copy, so if the cut rule or the character limit drifts, the preview quietly
 * stops matching the card strangers actually see — the one thing it exists to
 * prevent.
 *
 * The fallback is a presentation rule for `GET /members` ONLY (see
 * `toMemberCard`). Profile endpoints must serve the member's raw, unresolved
 * tagline: the editor seeds its short-bio input from that field, so returning
 * borrowed bio text there would let a member save words they never wrote.
 */

/** Roughly the two lines the card's CSS clamps the blurb to at 13px. */
export const DIRECTORY_BLURB_MAX_CHARS = 120;

/** Trailing punctuation left dangling by a mid-sentence cut, dropped before the ellipsis. */
const DANGLING_PUNCTUATION = /[\s.,;:!?—–-]+$/;

/**
 * Collapse whitespace and cut `text` to at most `maxChars`, breaking on a word
 * boundary and marking the cut with an ellipsis. Text already within the limit is
 * returned whitespace-collapsed and otherwise untouched — no ellipsis.
 */
export function truncateAtWord(
  text: string,
  maxChars: number = DIRECTORY_BLURB_MAX_CHARS,
): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= maxChars) return collapsed;
  // Look one character past the limit so a cut landing exactly on a space still
  // counts the preceding word as whole rather than dropping it.
  const clipped = collapsed.slice(0, maxChars + 1);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  // A single word longer than the whole limit has no boundary to break on, so
  // cut it mid-word rather than returning an ellipsis on its own.
  const cut =
    lastSpaceIndex > 0
      ? clipped.slice(0, lastSpaceIndex)
      : collapsed.slice(0, maxChars);
  return `${cut.replace(DANGLING_PUNCTUATION, '')}…`;
}

/**
 * Resolve the blurb for a member's directory card. Returns '' when the member has
 * written neither a short bio nor a bio — the card then shows an empty line, which
 * is honest.
 */
export function directoryBlurb(
  tagline: string | null | undefined,
  bio: string | null | undefined,
): string {
  const trimmedTagline = (tagline ?? '').trim();
  if (trimmedTagline) return trimmedTagline;
  const trimmedBio = (bio ?? '').trim();
  return trimmedBio ? truncateAtWord(trimmedBio) : '';
}
