import {
  compareSuggestions,
  isEmptyAffinity,
  scoreSuggestion,
  EMPTY_VIEWER_AFFINITY,
  SCORE_MUTUAL_CONNECTIONS,
  SCORE_SHARED_COMMUNITY,
  SCORE_SHARED_LANGUAGE,
  SCORE_SHARED_OPEN_TO,
  SCORE_SHARED_PROFESSION,
  SCORE_SHARED_TAG,
  type CandidateAffinity,
  type ViewerAffinity,
} from './member-suggestion-scoring';

function viewer(overrides: Partial<ViewerAffinity> = {}): ViewerAffinity {
  return {
    communityNamesById: new Map([
      ['community-1', 'Trans & Non-Binary Network'],
    ]),
    connectionUserIds: new Set(['connection-1']),
    openTo: [{ kind: 'preset', id: 'collaborating' }],
    tags: new Set(['ballroom']),
    professions: new Set(['photographer']),
    languages: new Set(['portuguese']),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CandidateAffinity> = {},
): CandidateAffinity {
  return {
    communityIds: [],
    mutualConnectionCount: 0,
    openTo: [],
    tags: [],
    professions: [],
    languages: [],
    ...overrides,
  };
}

describe('scoreSuggestion', () => {
  it('names the shared community and carries its name for the card', () => {
    const result = scoreSuggestion(
      viewer(),
      candidate({ communityIds: ['community-1'] }),
    );

    expect(result.score).toBe(SCORE_SHARED_COMMUNITY);
    expect(result.reason).toEqual({
      kind: 'community',
      label: 'Trans & Non-Binary Network',
      presetId: null,
      count: 1,
    });
  });

  it('carries the mutual-connection count so the card can say "3 mutual connections"', () => {
    const result = scoreSuggestion(
      viewer(),
      candidate({ mutualConnectionCount: 3 }),
    );

    expect(result.score).toBe(SCORE_MUTUAL_CONNECTIONS);
    expect(result.reason).toEqual({
      kind: 'mutuals',
      label: null,
      presetId: null,
      count: 3,
    });
  });

  it('adds every matching fact but names only the strongest one', () => {
    const result = scoreSuggestion(
      viewer(),
      candidate({
        communityIds: ['community-1'],
        mutualConnectionCount: 2,
        openTo: [{ kind: 'preset', id: 'collaborating' }],
        tags: ['ballroom'],
        professions: ['photographer'],
        languages: ['Portuguese'],
      }),
    );

    expect(result.score).toBe(
      SCORE_SHARED_COMMUNITY +
        SCORE_MUTUAL_CONNECTIONS +
        SCORE_SHARED_OPEN_TO +
        SCORE_SHARED_TAG +
        SCORE_SHARED_PROFESSION +
        SCORE_SHARED_LANGUAGE,
    );
    expect(result.reason?.kind).toBe('community');
  });

  it('sends a preset "open to" id for the client to translate, never a sentence', () => {
    const result = scoreSuggestion(
      viewer(),
      candidate({ openTo: [{ kind: 'preset', id: 'collaborating' }] }),
    );

    expect(result.reason).toEqual({
      kind: 'openTo',
      label: null,
      presetId: 'collaborating',
      count: 0,
    });
  });

  it('sends a custom "open to" phrase verbatim, in the words it was written in', () => {
    const result = scoreSuggestion(
      viewer({
        communityNamesById: new Map(),
        openTo: [{ kind: 'custom', label: 'Testing nights' }],
        tags: new Set(),
        professions: new Set(),
      }),
      candidate({ openTo: [{ kind: 'custom', label: 'testing NIGHTS' }] }),
    );

    expect(result.reason).toEqual({
      kind: 'openTo',
      label: 'testing NIGHTS',
      presetId: null,
      count: 0,
    });
  });

  it('matches tags case-insensitively and shows the spelling they used', () => {
    const result = scoreSuggestion(viewer(), candidate({ tags: ['Ballroom'] }));

    expect(result.reason).toEqual({
      kind: 'tag',
      label: 'Ballroom',
      presetId: null,
      count: 0,
    });
  });

  it('explains a shared profession, which is what onboarding collects', () => {
    const result = scoreSuggestion(
      viewer(),
      candidate({ professions: ['Photographer'] }),
    );

    expect(result.score).toBe(SCORE_SHARED_PROFESSION);
    expect(result.reason?.kind).toBe('profession');
  });

  it('never suggests someone whose only tie is a shared language', () => {
    // "You both speak Portuguese" explains nothing in a Lisbon-centred
    // network, so language scores only alongside a real tie.
    const result = scoreSuggestion(
      viewer(),
      candidate({ languages: ['Portuguese'] }),
    );

    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it('never suggests a stranger: no matching fact means no card', () => {
    const result = scoreSuggestion(viewer(), candidate());

    expect(result.score).toBe(0);
    expect(result.reason).toBeNull();
  });

  it('cannot be explained by an "open to" chip the directory would hide', () => {
    // A `network`/`private` candidate reaches the scorer with an empty
    // `openTo` (the caller applies `visibleOpenTo`), so the chip can neither
    // score nor appear as a reason.
    const result = scoreSuggestion(viewer(), candidate({ openTo: [] }));

    expect(result.reason).toBeNull();
  });

  it('reads nothing about identity: an identity field is not part of the input', () => {
    // The candidate shape has no identity member at all, which is the
    // enforcement. This test exists so adding one is a deliberate act with a
    // failing test attached.
    expect(Object.keys(candidate()).sort()).toEqual([
      'communityIds',
      'languages',
      'mutualConnectionCount',
      'openTo',
      'professions',
      'tags',
    ]);
  });
});

describe('isEmptyAffinity', () => {
  it('is true for a member who has joined, connected and written nothing', () => {
    expect(isEmptyAffinity(EMPTY_VIEWER_AFFINITY)).toBe(true);
  });

  it('is false as soon as the member has one fact of their own', () => {
    expect(
      isEmptyAffinity({
        ...EMPTY_VIEWER_AFFINITY,
        tags: new Set(['ballroom']),
      }),
    ).toBe(false);
  });
});

describe('compareSuggestions', () => {
  const scoreOf = (
    score: number,
    mutualConnectionCount = 0,
    sharedCommunityCount = 0,
  ) => ({ score, reason: null, mutualConnectionCount, sharedCommunityCount });

  it('puts the stronger score first', () => {
    expect(compareSuggestions(scoreOf(1), scoreOf(3))).toBeGreaterThan(0);
  });

  it('breaks a tie on mutual connections with the viewer', () => {
    expect(compareSuggestions(scoreOf(3, 1), scoreOf(3, 4))).toBeGreaterThan(0);
  });

  it('breaks a remaining tie on how many of the viewer rooms are shared', () => {
    expect(
      compareSuggestions(scoreOf(3, 2, 1), scoreOf(3, 2, 2)),
    ).toBeGreaterThan(0);
  });
});
