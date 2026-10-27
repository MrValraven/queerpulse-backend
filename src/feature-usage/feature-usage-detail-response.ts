/**
 * Wire shape of the lazy per-feature detail behind one expanded row of the
 * admin feature-usage panel, plus the `code` values its 404 responses carry.
 * Pure types and constants, no DB access, no Nest decorators.
 */

/** Every `code` a detail rejection carries (404), one per cause. */
export const FEATURE_USAGE_DETAIL_ERROR_CODES = {
  /** The key matches no entry in `launchedFeatures`. */
  unknownFeature: 'feature_usage_unknown_feature',
  /** The key is listed in `UNTRACKED_FEATURES`, so it is never measured. */
  featureNotTracked: 'feature_usage_feature_not_tracked',
} as const;

export type FeatureUsageDetailErrorCode =
  (typeof FEATURE_USAGE_DETAIL_ERROR_CODES)[keyof typeof FEATURE_USAGE_DETAIL_ERROR_CODES];

export interface AdminFeatureUsageDetailDTO {
  featureKey: string;
  /** Whole UTC days in the range; the length of `createdDaily`. */
  rangeDays: number;
  /** First included day, `YYYY-MM-DD`, INCLUSIVE. */
  rangeStart: string;
  /** Last included day, `YYYY-MM-DD`, INCLUSIVE. */
  rangeEnd: string;
  /**
   * Rows members created per UTC day over the range, oldest first,
   * zero-filled, summed across every entity `FEATURE_DEPTH` lists for the
   * feature. Length is always `rangeDays`, and its sum equals the row's
   * `depth` from the main endpoint for the same range. `null` for a
   * reach-only feature, which has no rows to count.
   */
  createdDaily: number[] | null;
}
