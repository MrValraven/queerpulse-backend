import sanitizeHtml from 'sanitize-html';
import { ArticleBlock } from './entities/magazine-article.entity';

/**
 * Server-side WRITE-boundary sanitizer for magazine article block rich text.
 *
 * Each article block carries inline rich text in an `html` field (and, for a
 * `qa` block, `q`; for an `image` block, `caption`), produced by the desk
 * editor's uncontrolled contentEditable surface. The public reader sanitizes
 * on READ (`queerpulse/.../desk/editor/sanitizeArticleHtml.ts`), but a crafted
 * API call to the draft-save route bypasses that entirely, so unsanitized
 * markup could be persisted and then rendered anywhere the reader is trusted.
 * We sanitize here, once, at the point of persistence, so the stored value is
 * always clean regardless of how it arrived.
 *
 * The allowlist MIRRORS the frontend reader exactly: tags `em`, `strong`, `a`,
 * `br` only; an `<a>` may carry only `href`, restricted to `http:`/`https:`/
 * `mailto:`, and always gets a forced `rel="noopener noreferrer"` +
 * `target="_blank"`. Every other tag is discarded (its safe text is kept, the
 * wrapper dropped), and script/style content is removed outright. `<script>`,
 * `<iframe>`, `<style>`, event-handler attributes, and `javascript:`/`data:`
 * URLs never survive.
 *
 * One deliberate, safe divergence from the reader: an `<a>` whose `href` fails
 * the scheme check keeps its (now href-less) tag here rather than being
 * unwrapped to bare text as the reader does. The security property — no unsafe
 * URL is ever stored — is identical; the read-path sanitizer still normalises
 * the cosmetic difference away.
 */
const ARTICLE_HTML_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['em', 'strong', 'a', 'br'],
  // `rel`/`target` are allowlisted so the forced values from `transformTags`
  // below survive the attribute filter; `href` is scheme-checked separately.
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
  allowProtocolRelative: false,
  // Discard a disallowed tag but keep its (already-sanitized) text children —
  // the reader's "unwrap" behaviour. `script`/`style` and the other default
  // `nonTextTags` have their content dropped entirely, which is safe.
  disallowedTagsMode: 'discard',
  transformTags: {
    // Force `rel`/`target` on every surviving anchor; keep the incoming href
    // (a disallowed scheme is stripped afterwards by `allowedSchemesByTag`).
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

/**
 * Sanitizes a single article rich-text `html` value down to the reader-safe
 * allowlist. Safe to call with untrusted input; never throws.
 */
export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, ARTICLE_HTML_SANITIZE_OPTIONS);
}

/**
 * Returns a copy of `blocks` with every rich-text field sanitized to the
 * reader-safe allowlist. Non-rich-text fields (`alt`, `credit`, `cite`, stats
 * labels, image `src`, …) are left untouched — they are stored and rendered as
 * plain text or validated separately. Applied by the one guarded article
 * write path so the stored value is always clean.
 */
export function sanitizeArticleBlocks(blocks: ArticleBlock[]): ArticleBlock[] {
  return blocks.map((block): ArticleBlock => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'pullQuote':
      case 'quote':
        return { ...block, html: sanitizeArticleHtml(block.html) };
      case 'qa':
        return {
          ...block,
          q: sanitizeArticleHtml(block.q),
          html: sanitizeArticleHtml(block.html),
        };
      case 'image':
        return { ...block, caption: sanitizeArticleHtml(block.caption) };
      case 'stats':
        return block;
    }
  });
}
