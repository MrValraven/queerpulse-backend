/**
 * How the "All" feed decides what to put near the top (SOC-04).
 *
 * WHAT THIS IS NOT. There is no engagement optimisation here and there is no
 * behavioural tracking anywhere behind it. Nothing counts opens, dwell time,
 * scroll depth, clicks or "similar members also liked". The only inputs are
 * three facts the member created ON PURPOSE and can undo at any time: they
 * joined a community, they accepted a connection, they followed a topic. That
 * is a hard product rule, not a first version.
 *
 * WHY IT STAYS EXPLAINABLE. Every ranked item carries the single fact that
 * lifted it (`FeedReason`), so the card can say "You're in Trans & Non-Binary
 * Network" rather than "recommended for you". A member who dislikes what
 * their feed shows can find the exact membership, connection or follow
 * responsible and change it.
 *
 * WHY THERE IS ALWAYS A CHRONOLOGICAL LANE. Ranking alone turns a small
 * network into a room where the same twelve people talk. The page is woven
 * from two lanes (see `interleaveByAffinity`), so a fixed share of every page
 * is plain "newest across the whole platform" regardless of score, and a
 * member who has joined nothing gets the exact reverse-chronological feed
 * that existed before any of this.
 */

/** The single fact that put an item where it is. Precedence is the weight
 *  order below: the strongest matching fact wins, and `recent` means no fact
 *  matched, i.e. this item is here because it is new. */
export type FeedReason = 'membership' | 'connection' | 'topic' | 'recent';

/**
 * Weights. Deliberately small integers with a deliberate order.
 *
 * A room you joined outranks a person you connected with, because the feed
 * card already shows the room and because membership is the more durable
 * statement ("this is a place I belong"). A followed topic is the weakest of
 * the three: it is a subject-matter interest, not a relationship.
 */
export const SCORE_MEMBERSHIP = 3;
export const SCORE_CONNECTION = 2;
export const SCORE_FOLLOWED_TOPIC = 1;

/** How many affinity-ranked items are emitted between each plain
 *  newest-first item. 3:1 means a fifth of every page is the chronological
 *  lane, so the whole platform stays visible from the home screen. */
export const PERSONAL_RUN_LENGTH = 3;

/** The three explicit graph facts, resolved once per feed request. */
export interface ViewerGraph {
  /** Communities the viewer is on the roster of. */
  communityIds: Set<string>;
  /** Users the viewer has an ACCEPTED connection with (either direction). */
  connectionUserIds: Set<string>;
  /** Topic slugs the viewer follows (`topic_follows.topic_slug`). */
  followedTopicSlugs: Set<string>;
}

export const EMPTY_VIEWER_GRAPH: ViewerGraph = {
  communityIds: new Set<string>(),
  connectionUserIds: new Set<string>(),
  followedTopicSlugs: new Set<string>(),
};

/** True when the viewer has created no graph facts at all: a brand-new
 *  member. Ranking is skipped entirely for them, which is both cheaper and
 *  exactly the behaviour that keeps day one from looking empty. */
export function isEmptyGraph(graph: ViewerGraph): boolean {
  return (
    graph.communityIds.size === 0 &&
    graph.connectionUserIds.size === 0 &&
    graph.followedTopicSlugs.size === 0
  );
}

/** The three things about one candidate the scorer can look at. Anything not
 *  on this list (view counts, reply velocity, how often the viewer opens this
 *  author) is out of bounds by design. */
export interface AffinityFacts {
  /** The community the item belongs to, or null for a flat/global item. */
  communityId: string | null;
  /** The author/host/joining member, or null for a tombstoned row. */
  authorId: string | null;
  /** Tags carried by the item's own subject: a community's curated tags for a
   *  post, a thread's freeform tags, a new member's public profile tags. A
   *  gathering has no tags column, so it never matches a followed topic. */
  tags: string[];
}

export interface AffinityScore {
  score: number;
  reason: FeedReason;
}

/**
 * The score for one candidate, plus the single fact to show the member.
 * Additive, so an item that is BOTH from your community and by your
 * connection outranks one that is only one of the two, while `reason` still
 * names the strongest of the matches rather than a vague blend.
 */
export function scoreAffinity(
  facts: AffinityFacts,
  graph: ViewerGraph,
): AffinityScore {
  const isFromMyCommunity =
    facts.communityId !== null && graph.communityIds.has(facts.communityId);
  const isFromMyConnection =
    facts.authorId !== null && graph.connectionUserIds.has(facts.authorId);
  const isOnFollowedTopic = facts.tags.some((tag) =>
    graph.followedTopicSlugs.has(tag),
  );

  const score =
    (isFromMyCommunity ? SCORE_MEMBERSHIP : 0) +
    (isFromMyConnection ? SCORE_CONNECTION : 0) +
    (isOnFollowedTopic ? SCORE_FOLLOWED_TOPIC : 0);

  if (isFromMyCommunity) return { score, reason: 'membership' };
  if (isFromMyConnection) return { score, reason: 'connection' };
  if (isOnFollowedTopic) return { score, reason: 'topic' };
  return { score: 0, reason: 'recent' };
}

/** The topic slug that actually matched, for the "Because you follow …" line.
 *  Null when nothing matched. First match wins, so the answer is stable. */
export function matchedTopicSlug(
  tags: string[],
  graph: ViewerGraph,
): string | null {
  return tags.find((tag) => graph.followedTopicSlugs.has(tag)) ?? null;
}

/**
 * Weaves one page order out of two lanes that PARTITION the candidates:
 *
 *  - the affinity lane: items with a score, strongest first and newest within
 *    an equal score;
 *  - the chronological lane: everything the member has no explicit tie to,
 *    newest first.
 *
 * `PERSONAL_RUN_LENGTH` items are taken from the affinity lane, then one from
 * the chronological lane, and so on; when one lane empties the other drains.
 * Because the lanes are disjoint, the result is a permutation of the input:
 * nothing is duplicated and nothing is dropped.
 *
 * The partition is what makes the tail real. If both lanes were drawn from
 * the whole candidate set, the "chronological" pick would almost always land
 * on another scored item and the member would never see past their own
 * corner of the platform.
 *
 * With no scored items the affinity lane is empty and the output is exactly
 * the chronological order, which is what a brand-new member sees.
 *
 * `scoreOf` and the comparator are passed in so this stays a pure function
 * over whatever the caller's candidate shape is.
 */
export function interleaveByAffinity<T>(
  candidates: T[],
  scoreOf: (candidate: T) => number,
  compareChronologicalDesc: (first: T, second: T) => number,
): T[] {
  if (candidates.length < 2) return [...candidates];

  const chronological = [...candidates].sort(compareChronologicalDesc);
  const affinityLane = chronological
    .filter((candidate) => scoreOf(candidate) > 0)
    .sort((first, second) => {
      const scoreDifference = scoreOf(second) - scoreOf(first);
      if (scoreDifference !== 0) return scoreDifference;
      return compareChronologicalDesc(first, second);
    });
  if (!affinityLane.length) return chronological;

  const chronologicalLane = chronological.filter(
    (candidate) => scoreOf(candidate) <= 0,
  );

  const ordered: T[] = [];
  let affinityIndex = 0;
  let chronologicalIndex = 0;

  while (
    affinityIndex < affinityLane.length ||
    chronologicalIndex < chronologicalLane.length
  ) {
    for (
      let taken = 0;
      taken < PERSONAL_RUN_LENGTH && affinityIndex < affinityLane.length;
      taken += 1
    ) {
      ordered.push(affinityLane[affinityIndex]!);
      affinityIndex += 1;
    }
    if (chronologicalIndex < chronologicalLane.length) {
      ordered.push(chronologicalLane[chronologicalIndex]!);
      chronologicalIndex += 1;
    }
  }

  return ordered;
}
