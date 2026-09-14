import { classifyFeatures, hasReachSignal } from './feature-usage-response';

describe('classifyFeatures', () => {
  const base = { depthTotal: 0, reachPrevious: 0 };

  it('marks an unlaunched feature not-launched regardless of its numbers', () => {
    const [feature] = classifyFeatures([
      { ...base, featureKey: 'jobs', isLaunched: false, reach: 900, depth: 90 },
    ]);
    expect(feature?.state).toBe('not-launched');
  });

  it('excludes unlaunched features from the medians', () => {
    // Chosen so the unlaunched row's reach actually moves the median if it
    // leaks into the calculation. With `jobs` excluded (correct), the reach
    // median is over the two launched features only: median([100, 300]) =
    // 200, forum's reach of 100 is below it, so forum is quiet. With `jobs`
    // included (i.e. if `.filter((row) => row.isLaunched)` were removed),
    // the median becomes median([50, 100, 300]) = 100, forum's reach of 100
    // is no longer below it, so forum would read busy instead. The two
    // scenarios disagree on forum's state, so this fails if the filter is
    // dropped.
    const classified = classifyFeatures([
      {
        ...base,
        featureKey: 'jobs',
        isLaunched: false,
        reach: 50,
        depth: 0,
      },
      { ...base, featureKey: 'forum', isLaunched: true, reach: 100, depth: 50 },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 300,
        depth: 50,
      },
    ]);
    expect(classified.find((f) => f.featureKey === 'forum')?.state).toBe(
      'quiet',
    );
  });

  it('calls a feature with healthy reach and near-zero depth browsed-but-empty', () => {
    const classified = classifyFeatures([
      {
        ...base,
        featureKey: 'housingListings',
        isLaunched: true,
        reach: 4000,
        depth: 1,
      },
      {
        ...base,
        featureKey: 'forum',
        isLaunched: true,
        reach: 100,
        depth: 200,
      },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 80,
        depth: 150,
      },
    ]);
    expect(
      classified.find((f) => f.featureKey === 'housingListings')?.state,
    ).toBe('browsed-but-empty');
  });

  it('calls a feature below both medians quiet', () => {
    const classified = classifyFeatures([
      { ...base, featureKey: 'culture', isLaunched: true, reach: 1, depth: 0 },
      {
        ...base,
        featureKey: 'forum',
        isLaunched: true,
        reach: 500,
        depth: 200,
      },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 400,
        depth: 150,
      },
    ]);
    expect(classified.find((f) => f.featureKey === 'culture')?.state).toBe(
      'quiet',
    );
  });

  it('classifies a reach-only feature on reach alone', () => {
    const classified = classifyFeatures([
      {
        ...base,
        featureKey: 'feed',
        isLaunched: true,
        reach: 900,
        depth: null,
      },
      { ...base, featureKey: 'forum', isLaunched: true, reach: 100, depth: 10 },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 80,
        depth: 8,
      },
    ]);
    const feed = classified.find((feature) => feature.featureKey === 'feed');
    expect(feed?.state).toBe('busy');
    expect(feed?.depth).toBeNull();
  });

  // A zero reach median (every launched feature has zero reach in the
  // selected range) is the platform-wide state for roughly the first day
  // after deploy, since `rangeEnd` excludes today, and for any range
  // predating the `feature_usage_daily` table. `row.reach >= 0` is true for
  // every row, so without this guard every launched feature whose depth is
  // under a quarter of the depth median would misread as browsed-but-empty.
  it('treats a zero reach median as no reach signal, so nothing reads browsed-but-empty off it', () => {
    const rows = [
      {
        ...base,
        featureKey: 'housingListings',
        isLaunched: true,
        reach: 0,
        depth: 1,
      },
      { ...base, featureKey: 'forum', isLaunched: true, reach: 0, depth: 200 },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 0,
        depth: 150,
      },
    ];

    expect(hasReachSignal(rows)).toBe(false);

    const classified = classifyFeatures(rows);
    for (const feature of classified) {
      expect(feature.state).not.toBe('browsed-but-empty');
    }
    expect(
      classified.find((feature) => feature.featureKey === 'housingListings')
        ?.state,
    ).toBe('quiet');
  });

  it('reports a reach signal once at least one launched feature has nonzero reach', () => {
    const rows = [
      { ...base, featureKey: 'forum', isLaunched: true, reach: 5, depth: 200 },
      {
        ...base,
        featureKey: 'magazine',
        isLaunched: true,
        reach: 0,
        depth: 150,
      },
    ];

    expect(hasReachSignal(rows)).toBe(true);
  });

  it('reports no reach signal when every reach value comes from unlaunched features', () => {
    const rows = [
      { ...base, featureKey: 'jobs', isLaunched: false, reach: 900, depth: 90 },
      { ...base, featureKey: 'forum', isLaunched: true, reach: 0, depth: 200 },
    ];

    expect(hasReachSignal(rows)).toBe(false);
  });
});
