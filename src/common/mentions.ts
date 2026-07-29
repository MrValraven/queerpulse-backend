export interface ExtractedMentions {
  members: string[];
  communities: string[];
  businesses: string[];
  events: string[];
  threads: string[];
}

// `@slug`, `c/slug`, `b/slug`, `e/slug`, `t/slug` at a boundary (string start or
// after whitespace). The boundary guard keeps `me@host.com` / `.../c/x` plain.
// Topics (`#`) are intentionally excluded — a topic has no owner to notify.
const MENTION_TOKEN = /(?:^|\s)(@|c\/|b\/|e\/|t\/)([a-z0-9][a-z0-9-]*)/g;

const BUCKET_BY_SIGIL: Record<string, keyof ExtractedMentions> = {
  '@': 'members',
  'c/': 'communities',
  'b/': 'businesses',
  'e/': 'events',
  't/': 'threads',
};

export function extractMentions(body: string): ExtractedMentions {
  const result: ExtractedMentions = {
    members: [],
    communities: [],
    businesses: [],
    events: [],
    threads: [],
  };
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const sigil = match[1];
    const slug = match[2];
    if (sigil === undefined || slug === undefined) continue;
    const bucketKey = BUCKET_BY_SIGIL[sigil];
    if (bucketKey === undefined) continue;
    const bucket = result[bucketKey];
    if (!bucket.includes(slug)) bucket.push(slug);
  }
  return result;
}

/** Member slugs only — back-compat for existing callers/tests. */
export function extractMentionSlugs(body: string): string[] {
  return extractMentions(body).members;
}
