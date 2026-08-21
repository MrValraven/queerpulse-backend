/**
 * The curated tag vocabulary a community owner can attach to their community
 * (spec: curated Community tags). Sibling of `src/profiles/professions.ts` /
 * `src/profiles/languages.ts`: these ids are the wire contract between
 * `communities.tags` (what an owner sets on their community) and
 * `GET /communities?tags=` (what a browsing member filters by) — the SAME
 * ids must drive both, or the filter goes quietly dark the way the member
 * directory's identity filter once did (see AddDiscoverableIdentities1782800770000).
 * Mirrors the frontend's identical list — keep the two in lockstep; this list
 * is the authority and `CreateCommunityDto`/`UpdateCommunityDto` reject
 * anything outside it via `@IsIn(COMMUNITY_TAGS, { each: true })`.
 *
 * Curated (not freeform), unlike `forum_thread.tags`: a community's tags are
 * a fixed set of browse facets, not per-post free text.
 */
export const COMMUNITY_TAGS = [
  // Identity & community focus
  'trans-nonbinary',
  'sapphic-wlw',
  'gay-men',
  'bisexual-pan',
  'asexual-aromantic',
  'two-spirit',
  'intersex',
  'bipoc-led',
  'disability-chronic-illness',
  'neurodivergent',
  'deaf-hard-of-hearing',
  'elders-50-plus',
  'youth-18-24',
  'parents-family',
  'polyamory-enm',
  'leather-kink',
  'bear-cub',
  'drag-performance',

  // Format & vibe
  'beginner-friendly',
  'in-person-meetups',
  'virtual-online',
  'local-city-based',
  'peer-support',
  'discussion-group',
  'book-club',
  'study-group',
  'game-night',
  'sober-substance-free',
  'twelve-step-recovery',
  'creative-collective',
  'mentorship',

  // Focus & interests
  'mental-health',
  'coming-out-support',
  'health-wellness',
  'career-networking',
  'housing-roommates',
  'legal-immigration',
  'faith-spirituality',
  'sports-fitness',
  'outdoors-hiking',
  'music',
  'film-tv',
  'tech-gaming',
  'fashion-style',
  'food-cooking',
  'arts-crafts',
  'activism-mutual-aid',
  'politics-advocacy',
  'nightlife-events',

  // Health & identity
  'hiv-wellness',
  'trans-health-medical',
  'sex-worker-allies',
  'accessibility-first',
] as const;

export type CommunityTag = (typeof COMMUNITY_TAGS)[number];

const COMMUNITY_TAG_SET: ReadonlySet<string> = new Set(COMMUNITY_TAGS);

export function isCommunityTag(value: string): boolean {
  return COMMUNITY_TAG_SET.has(value);
}

/** Keep only the ids that are actually in the taxonomy — an unrecognised id
 *  submitted by a stale/malicious client is dropped, not stored/filtered on. */
export function knownCommunityTags(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isCommunityTag))];
}
