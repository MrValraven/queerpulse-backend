import {
  EMPTY_VIEWER_GRAPH,
  interleaveByAffinity,
  isEmptyGraph,
  matchedTopicSlug,
  scoreAffinity,
  SCORE_CONNECTION,
  SCORE_FOLLOWED_TOPIC,
  SCORE_MEMBERSHIP,
  type ViewerGraph,
} from './feed-affinity';

const graphWith = (overrides: Partial<ViewerGraph> = {}): ViewerGraph => ({
  ...EMPTY_VIEWER_GRAPH,
  communityIds: new Set(overrides.communityIds ?? []),
  connectionUserIds: new Set(overrides.connectionUserIds ?? []),
  followedTopicSlugs: new Set(overrides.followedTopicSlugs ?? []),
});

describe('scoreAffinity', () => {
  it('scores only the three explicit facts a member created', () => {
    const graph = graphWith({
      communityIds: new Set(['community-1']),
      connectionUserIds: new Set(['user-1']),
      followedTopicSlugs: new Set(['housing']),
    });

    expect(
      scoreAffinity(
        { communityId: 'community-1', authorId: 'user-1', tags: ['housing'] },
        graph,
      ),
    ).toEqual({
      score: SCORE_MEMBERSHIP + SCORE_CONNECTION + SCORE_FOLLOWED_TOPIC,
      reason: 'membership',
    });
  });

  it('names the strongest matching fact as the reason', () => {
    const graph = graphWith({
      connectionUserIds: new Set(['user-1']),
      followedTopicSlugs: new Set(['housing']),
    });

    expect(
      scoreAffinity(
        { communityId: null, authorId: 'user-1', tags: ['housing'] },
        graph,
      ).reason,
    ).toBe('connection');
  });

  it('scores nothing, and reads as "recent", when no fact matches', () => {
    expect(
      scoreAffinity(
        { communityId: 'other', authorId: 'stranger', tags: ['gardening'] },
        graphWith({ communityIds: new Set(['community-1']) }),
      ),
    ).toEqual({ score: 0, reason: 'recent' });
  });

  it('reports which followed topic actually matched', () => {
    const graph = graphWith({ followedTopicSlugs: new Set(['trans']) });
    expect(matchedTopicSlug(['nightlife', 'trans'], graph)).toBe('trans');
    expect(matchedTopicSlug(['nightlife'], graph)).toBeNull();
  });

  it('recognises a member who has joined, connected and followed nothing', () => {
    expect(isEmptyGraph(EMPTY_VIEWER_GRAPH)).toBe(true);
    expect(isEmptyGraph(graphWith({ communityIds: new Set(['c']) }))).toBe(
      false,
    );
  });
});

describe('interleaveByAffinity', () => {
  // Newest first, by the numeric `at` on the fixture.
  interface Row {
    id: string;
    at: number;
    score: number;
  }
  const chronological = (first: Row, second: Row) => second.at - first.at;
  const scoreOf = (row: Row) => row.score;

  it('keeps a chronological lane, so unscored items are never buried', () => {
    const scored = [1, 2, 3, 4, 5].map((index) => ({
      id: `scored-${index}`,
      at: 100 - index,
      score: 3,
    }));
    const unscored = [1, 2].map((index) => ({
      id: `plain-${index}`,
      at: 50 - index,
      score: 0,
    }));

    const ordered = interleaveByAffinity(
      [...scored, ...unscored],
      scoreOf,
      chronological,
    );

    // Three scored, one plain, three scored... never five scored in a row.
    expect(ordered.map((row) => row.id)).toEqual([
      'scored-1',
      'scored-2',
      'scored-3',
      'plain-1',
      'scored-4',
      'scored-5',
      'plain-2',
    ]);
  });

  it('is a permutation: nothing is duplicated and nothing is dropped', () => {
    const rows = [
      { id: 'a', at: 5, score: 3 },
      { id: 'b', at: 4, score: 0 },
      { id: 'c', at: 3, score: 2 },
      { id: 'd', at: 2, score: 0 },
    ];

    const ordered = interleaveByAffinity(rows, scoreOf, chronological);

    expect(ordered).toHaveLength(rows.length);
    expect(new Set(ordered.map((row) => row.id))).toEqual(
      new Set(['a', 'b', 'c', 'd']),
    );
  });

  it('falls back to pure reverse-chronological order when nothing scores', () => {
    const rows = [
      { id: 'old', at: 1, score: 0 },
      { id: 'new', at: 9, score: 0 },
    ];

    expect(
      interleaveByAffinity(rows, scoreOf, chronological).map((row) => row.id),
    ).toEqual(['new', 'old']);
  });
});
