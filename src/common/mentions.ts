// Mirrors the frontend `parseMentions` grammar for members only: `@slug` at a
// boundary (string start or after whitespace), slug = lowercase/digit/hyphen.
// The boundary guard is what stops `me@host.com` counting as a mention.
const MEMBER_MENTION = /(?:^|\s)@([a-z0-9][a-z0-9-]*)/g;

/** Member slugs mentioned in a post body, deduped and in first-seen order.
 *  Community (`c/`) tokens are intentionally excluded — a community is not a
 *  person to notify. */
export function extractMentionSlugs(body: string): string[] {
  const slugs: string[] = [];
  for (const match of body.matchAll(MEMBER_MENTION)) {
    const slug = match[1];
    if (!slugs.includes(slug)) {
      slugs.push(slug);
    }
  }
  return slugs;
}
