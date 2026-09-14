/**
 * Shape the admin feature-usage panel renders, plus the classification math
 * behind it. Pure DTO + mapper helpers only, no DB access, no Nest decorators,
 * mirroring `../admin-overview/admin-overview-response.ts`, so the
 * classification stays directly unit-testable.
 */
export type FeatureUsageState =
  'busy' | 'browsed-but-empty' | 'quiet' | 'not-launched';

export interface FeatureUsageRow {
  featureKey: string;
  isLaunched: boolean;
  /** Requests over the selected range. */
  reach: number;
  /** Rows created over the selected range. `null` for a reach-only feature. */
  depth: number | null;
  /** Rows in existence at the end of the range. `null` for reach-only. */
  depthTotal: number | null;
  /** Reach over the preceding range of equal length, for direction. */
  reachPrevious: number;
  /**
   * Why a reach-only feature has no depth to show, so the frontend can render
   * an explanation where a zero would otherwise read as "nothing happened".
   * Optional so a hand-built row (a test) can omit it; the service always
   * sets it, to `FEATURE_DEPTH`'s stated reason for a reach-only feature and
   * to `null` for a feature with a `rows` spec.
   */
  reason?: string | null;
}

export interface ClassifiedFeature extends FeatureUsageRow {
  state: FeatureUsageState;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  // invariant: `middle` (and `middle - 1` in the even case) are valid indices
  // into `sorted`, since the empty case returned above, so length >= 1 here.
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function computeReachMedian(rows: FeatureUsageRow[]): number {
  const launched = rows.filter((row) => row.isLaunched);
  return median(launched.map((row) => row.reach));
}

/**
 * True only when at least one launched feature has nonzero reach in the
 * selected range, so the reach median is itself a meaningful threshold. A
 * zero median (every launched feature reads zero reach, which is the
 * platform-wide state for roughly the first day after deploy, since
 * `rangeEnd` excludes today, and for any range predating the
 * `feature_usage_daily` table) would otherwise make `row.reach >= reachMedian`
 * true for every feature, including ones with zero reach. Exported so the
 * service can surface it on the DTO and the frontend can say "no reach was
 * recorded for this range" instead of rendering a classification built on no
 * data.
 */
export function hasReachSignal(rows: FeatureUsageRow[]): boolean {
  return computeReachMedian(rows) > 0;
}

/**
 * Thresholds are relative to the platform's own medians rather than absolute,
 * so they keep meaning as the member base grows. Both medians are taken over
 * LAUNCHED features only: a feature flagged off has no traffic by construction
 * and would drag the median down for everything else.
 */
export function classifyFeatures(rows: FeatureUsageRow[]): ClassifiedFeature[] {
  const launched = rows.filter((row) => row.isLaunched);
  const reachMedian = computeReachMedian(rows);
  const isReachSignalPresent = reachMedian > 0;
  const depthMedian = median(
    launched
      .filter((row) => row.depth !== null)
      .map((row) => row.depth as number),
  );
  const nearZeroDepth = depthMedian / 4;

  return rows.map((row) => {
    if (!row.isLaunched) {
      return { ...row, state: 'not-launched' as const };
    }

    // A zero reach median carries no signal (see `hasReachSignal`), so no
    // feature can be read as having healthy reach off of it, and in
    // particular no feature can land in `browsed-but-empty` from a
    // measurement artefact rather than an actual reach-without-depth gap.
    const hasHealthyReach = isReachSignalPresent && row.reach >= reachMedian;

    if (row.depth === null) {
      return {
        ...row,
        state: hasHealthyReach ? 'busy' : 'quiet',
      };
    }

    if (hasHealthyReach && row.depth < nearZeroDepth) {
      return { ...row, state: 'browsed-but-empty' as const };
    }

    return {
      ...row,
      state: hasHealthyReach ? 'busy' : 'quiet',
    };
  });
}

export interface AdminFeatureUsageDTO {
  rangeDays: number;
  /**
   * False when the reach median over launched features is zero, so `state`
   * on every feature below was computed with no reach threshold to compare
   * against. The frontend should say reach was not recorded for this range
   * rather than trust a `busy`/`quiet`/`browsed-but-empty` split built on no
   * data. See `hasReachSignal`.
   */
  hasReachSignal: boolean;
  /** Ordered so the states that need a decision come first. */
  features: ClassifiedFeature[];
  /**
   * Every count below is scoped to the same `[rangeStart, rangeEnd)` window
   * `depth` uses, with one exception: `communities.stillPostingThisWeek`.
   */
  drillDowns: {
    housingListings: {
      listings: number;
      savedSearches: number;
      viewings: number;
    };
    forum: { threads: number; replies: number };
    communities: {
      created: number;
      /**
       * Communities whose `activeThisWeek` (maintained by
       * `CommunityActivityCounterService`) is above zero. This is a ROLLING
       * seven days measured from whenever that counter job last ran,
       * independent of the selected range and of `rangeDays`. Its freshness
       * depends entirely on when that job last ran.
       */
      stillPostingThisWeek: number;
    };
  };
}
