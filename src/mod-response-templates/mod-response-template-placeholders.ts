/**
 * The complete substitution set a moderator response template may use.
 *
 * Deliberately tiny. A template is a starting point a moderator edits, so the
 * placeholders only cover the two facts that change on every single decision
 * and are tedious to retype: who the note is addressed to, and where it
 * happened. Everything else belongs in the body as plain words.
 *
 * WHERE SUBSTITUTION HAPPENS. In the frontend, at prefill time
 * (`AdminResponseTemplatePicker`), before the text reaches the note field. The
 * moderator therefore sees, and can edit, the final wording before it is sent.
 * The backend stores whatever text the moderator approved. A template id is
 * never stored on the action and never resolved later, so editing a template
 * can never retroactively change what a member was told.
 *
 * `{community}` has no value on a report that is not scoped to a community.
 * The frontend renders `COMMUNITY_FALLBACK` there ("the platform" in the
 * moderator's language) rather than leaving a raw brace on screen.
 */
export const TEMPLATE_PLACEHOLDERS = ['member', 'community'] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** Matches `{member}` / `{community}` and any other single-brace token, so an
 *  unknown one can be rejected at the write boundary instead of shipping to a
 *  moderator as a literal brace in a member-facing note. */
export const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

/** Every `{token}` in `body` that is not in `TEMPLATE_PLACEHOLDERS`, in the
 *  order they appear, deduplicated. Empty when the body is clean. */
export function unknownPlaceholders(body: string): string[] {
  const known = new Set<string>(TEMPLATE_PLACEHOLDERS);
  const found: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const token = match[1];
    if (token === undefined) continue;
    if (!known.has(token) && !found.includes(token)) found.push(token);
  }
  return found;
}
