import sanitizeHtml from 'sanitize-html';

/**
 * Write-boundary plain-text normaliser for community-authored short text
 * (a resource title and note, an owner-review reason).
 *
 * This repo strips markup once, where the value is persisted, rather than at
 * every render site: `sanitizeArticleHtml`
 * (`src/magazine/article-html-sanitizer.ts`) is the precedent, and it exists
 * because a crafted API call bypasses whatever the client does on the way in.
 * The difference here is that none of these fields are rich text at all, so
 * the allowlist is empty: every tag is discarded and only its text survives.
 * A stored value can therefore never carry a link, an inline handler, or
 * anything a renderer could be talked into interpreting.
 */
const PLAIN_TEXT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  // Drop the tag, keep its text. `script`/`style` and the other default
  // `nonTextTags` still have their CONTENT dropped entirely, so
  // `<script>alert(1)</script>` leaves nothing behind rather than leaving the
  // bare call as text.
  disallowedTagsMode: 'discard',
};

// sanitize-html re-encodes the text it emits, so a plain `Tom & Jerry` comes
// back as `Tom &amp; Jerry`. These are the only entities it produces, and a
// plain-text column must hold the characters themselves. `&amp;` is decoded
// LAST so `&amp;lt;` cannot be folded into a `<` that was never typed.
const ENTITY_DECODINGS: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

function stripOnce(value: string): string {
  let stripped = sanitizeHtml(value, PLAIN_TEXT_SANITIZE_OPTIONS);
  for (const [pattern, character] of ENTITY_DECODINGS) {
    stripped = stripped.replace(pattern, character);
  }
  return stripped;
}

/**
 * The value as it should be STORED: no markup, no entity-encoded markup, no
 * surrounding whitespace.
 *
 * Runs to a fixed point (bounded, so a hostile input cannot spin here)
 * because decoding is part of the strip: an input of `&lt;b&gt;hi` is
 * tag-free on the first pass and only becomes `<b>hi` once decoded, so a
 * second pass is what actually removes it. Two passes settle every realistic
 * input; the third is the guard rail.
 */
export function toStoredPlainText(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    const stripped = stripOnce(current);
    if (stripped === current) break;
    current = stripped;
  }
  return current.trim();
}

/**
 * `toStoredPlainText` for a nullable column: an absent value, or one that
 * strips down to nothing at all, is stored as NULL rather than as an empty
 * string that every read site then has to treat as empty anyway.
 */
export function toStoredPlainTextOrNull(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  const stored = toStoredPlainText(value);
  return stored.length ? stored : null;
}
