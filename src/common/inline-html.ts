import sanitizeHtml from 'sanitize-html';

/**
 * The inline rich-text allowlist shared by every surface that stores short
 * formatted prose: magazine article blocks and resource guide blocks.
 *
 * Tags `em`, `strong`, `a`, `br` only; an `<a>` keeps only `href`, limited to
 * `http:`/`https:`/`mailto:`, and always gets `rel="noopener noreferrer"` and
 * `target="_blank"`. Everything else is discarded, and script/style content
 * is removed outright. The frontend reader enforces the same allowlist on
 * read (`src/shared/components/richText/sanitizeArticleHtml.ts`).
 */
export const INLINE_HTML_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['em', 'strong', 'a', 'br'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (_tagName: string, attribs: Record<string, string>) => ({
      tagName: 'a',
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
  },
};

export function sanitizeInlineHtml(html: string): string {
  return sanitizeHtml(html, INLINE_HTML_SANITIZE_OPTIONS);
}

const PLAIN_TEXT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: 'discard',
};

// sanitize-html re-encodes the text it emits. `&amp;` is decoded LAST so
// `&amp;lt;` becomes the literal text `&lt;` rather than a `<` nobody typed.
// Same order as `src/communities/community-plain-text.ts`.
const ENTITY_DECODINGS: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

/**
 * The text a reader sees in sanitized inline HTML: `<br>` becomes a newline,
 * tags are dropped, entities are decoded once, non-breaking spaces become
 * spaces. Used to derive a guide block's `text` (search, `body`, word counts)
 * from its `html`.
 */
export function inlineHtmlToPlainText(html: string): string {
  const withLineBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  let text = sanitizeHtml(withLineBreaks, PLAIN_TEXT_SANITIZE_OPTIONS);
  for (const [pattern, character] of ENTITY_DECODINGS) {
    text = text.replace(pattern, character);
  }
  return text.replace(/\u00a0/g, ' ').trim();
}
