/**
 * Character-safe measuring and cutting for member-typed text.
 *
 * A JavaScript string is UTF-16, so an emoji such as U+1F600 is TWO code
 * units (a surrogate pair). `String.prototype.slice` cuts in code units and
 * can keep the first half of a pair on its own. That lone half has no
 * character to render, and `JSON.stringify` writes it as the escape
 * `\ud83d`, which Postgres refuses in a `jsonb` value ("Unicode low surrogate
 * must follow a high surrogate"): a cut caption or excerpt made the whole
 * save fail with a 500.
 *
 * These helpers count in the unit class-validator's `@MaxLength` /
 * `maxLength` uses (`validator`'s `isLength`): one per code point, with the
 * text and emoji presentation selectors (U+FE0E, U+FE0F) counting zero. A
 * bound checked by the DTO and a cut applied by the service therefore agree
 * on what "1000 characters" means, and every result is well formed.
 */

const PRESENTATION_SELECTORS = new Set(['︎', '️']);

/** A high surrogate with no low surrogate after it, or a low surrogate with no high surrogate before it. */
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const isLowSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

/**
 * Drops every unpaired surrogate half. A client can send one directly as a
 * JSON `\ud83d` escape; it renders as nothing useful and would fail a `jsonb`
 * write, so text bound for storage or a response carries none.
 */
export function removeLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_PATTERN, '');
}

/** The length `@MaxLength` measures: code points, presentation selectors excluded. */
export function countCharacters(text: string): number {
  let characterCount = 0;
  for (const codePoint of text) {
    if (!PRESENTATION_SELECTORS.has(codePoint)) {
      characterCount += 1;
    }
  }
  return characterCount;
}

/**
 * The leading `maxCharacters` characters of `text`, counted like
 * `countCharacters`, with no lone surrogate anywhere in the result. A
 * presentation selector right after the last kept character stays with it,
 * so a cut after a heart keeps its emoji form. Text already within the bound
 * comes back whole (minus any lone surrogate it arrived with).
 */
export function truncateCharacters(
  text: string,
  maxCharacters: number,
): string {
  const wellFormed = removeLoneSurrogates(text);
  // A code point is at least one code unit, so a string this short can
  // never hold more characters than the bound.
  if (wellFormed.length <= maxCharacters) {
    return wellFormed;
  }
  let characterCount = 0;
  let endIndex = 0;
  for (const codePoint of wellFormed) {
    if (!PRESENTATION_SELECTORS.has(codePoint)) {
      if (characterCount === maxCharacters) {
        break;
      }
      characterCount += 1;
    }
    endIndex += codePoint.length;
  }
  return wellFormed.slice(0, endIndex);
}

/**
 * Widens the code-unit range `[start, end)` of `text` so neither edge lands
 * between the two halves of a surrogate pair: a start on a low surrogate
 * moves back onto its high surrogate, and an end right after a high
 * surrogate moves forward past its low surrogate. For windows cut around an
 * `indexOf` match, where the offsets are code units by nature.
 */
export function widenToCodePointBoundaries(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const widenedStart =
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
      ? start - 1
      : start;
  const widenedEnd =
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
      ? end + 1
      : end;
  return { start: widenedStart, end: widenedEnd };
}
