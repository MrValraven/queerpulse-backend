import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { isFeatureKey } from '../launchedFeatures';
import {
  FEATURE_DEPTH,
  isTrackedFeature,
  TrackedFeatureKey,
} from './feature-depth';
import {
  AdminFeatureUsageDetailDTO,
  FEATURE_USAGE_DETAIL_ERROR_CODES,
  FeatureUsageDetailErrorCode,
} from './feature-usage-detail-response';
import {
  describeUsageRange,
  listUtcDays,
  UsageRange,
} from './feature-usage-range';

/**
 * Caps the per-entity fan-out against the shared pool. The widest
 * `FEATURE_DEPTH` entry lists two entities today, so the cap only bites if a
 * feature grows past six. Same cap as `MAX_CONCURRENT_USAGE_COUNTS` in
 * `admin-feature-usage.service.ts`.
 */
const MAX_CONCURRENT_DETAIL_COUNTS = 6;

/** Longest slice of a rejected feature key echoed back in an error message. */
const MAX_ECHOED_KEY_LENGTH = 48;

/**
 * The UTC calendar day a row was created on, as `YYYY-MM-DD`. Every
 * `FEATURE_DEPTH` entity stores `createdAt` as `timestamptz`, so
 * `AT TIME ZONE 'UTC'` yields the UTC wall-clock time and `::date` its UTC
 * day, independent of the session time zone. Written against the property
 * path `row.createdAt` so TypeORM resolves it to the entity's real column,
 * the same way it resolves the range predicates below. Precedent for the
 * grouped `to_char` shape: `communities/community-insights.service.ts`.
 */
const CREATED_DAY_EXPRESSION =
  "to_char((row.createdAt AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')";

function notFoundError(
  code: FeatureUsageDetailErrorCode,
  message: string,
): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code,
    message,
  });
}

function echoKey(featureKey: string): string {
  return JSON.stringify(featureKey.slice(0, MAX_ECHOED_KEY_LENGTH));
}

/** Narrows a raw route param to a measured feature key, or throws a 404 whose
 *  `code` names which check the key failed. */
function requireTrackedFeatureKey(featureKey: string): TrackedFeatureKey {
  if (!isFeatureKey(featureKey)) {
    throw notFoundError(
      FEATURE_USAGE_DETAIL_ERROR_CODES.unknownFeature,
      `No feature is registered under the key ${echoKey(featureKey)}; the key has to match an entry in launchedFeatures.`,
    );
  }
  if (!isTrackedFeature(featureKey)) {
    throw notFoundError(
      FEATURE_USAGE_DETAIL_ERROR_CODES.featureNotTracked,
      `The feature ${echoKey(featureKey)} is listed in UNTRACKED_FEATURES and is never measured by design, so it has no usage detail.`,
    );
  }
  return featureKey;
}

/**
 * Lazy per-feature detail behind one expanded row of the admin feature-usage
 * panel: rows members created per UTC day over the selected range. Fetched
 * only when a row opens, so the main endpoint stays one grouped reach read
 * plus totals.
 *
 * INVARIANT: `sum(createdDaily)` equals the row's `depth` from
 * `AdminFeatureUsageService.getUsage` for the same `UsageRange`. Both read the
 * same entities from `FEATURE_DEPTH` with the same predicates,
 * `row.createdAt >= :rangeStart AND row.createdAt < :rangeEnd` against the
 * same `Date` values, so grouping the rows by UTC day only splits that one
 * count across days. The spec asserts the predicate strings and parameters
 * match the depth queries call for call.
 */
@Injectable()
export class AdminFeatureUsageDetailService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Throws a `NotFoundException` with `feature_usage_unknown_feature` when the
   * key is missing from `launchedFeatures`, or
   * `feature_usage_feature_not_tracked` when it is listed in
   * `UNTRACKED_FEATURES`. A reach-only feature returns `createdDaily: null`
   * and issues zero queries.
   */
  async getDetail(
    featureKey: string,
    range: UsageRange,
  ): Promise<AdminFeatureUsageDetailDTO> {
    const trackedFeatureKey = requireTrackedFeatureKey(featureKey);
    const { rangeStart, rangeEnd } = describeUsageRange(range);
    const detailBase = {
      featureKey: trackedFeatureKey,
      rangeDays: range.rangeDays,
      rangeStart,
      rangeEnd,
    };

    const spec = FEATURE_DEPTH[trackedFeatureKey];
    if (spec.kind === 'reach-only') {
      return { ...detailBase, createdDaily: null };
    }

    const createdPerDayByEntity = await runWithConcurrency(
      spec.entities.map(
        (entity) => () =>
          this.countRowsCreatedPerDay(entity, range.rangeStart, range.rangeEnd),
      ),
      MAX_CONCURRENT_DETAIL_COUNTS,
    );
    const createdDaily = listUtcDays(range.rangeStart, range.rangeDays).map(
      (day) =>
        createdPerDayByEntity.reduce(
          (total, createdPerDay) => total + (createdPerDay.get(day) ?? 0),
          0,
        ),
    );

    return { ...detailBase, createdDaily };
  }

  /** Rows of `entity` created inside `[rangeStart, rangeEnd)`, grouped by UTC
   *  day in one query. Keyed by `YYYY-MM-DD`; a day with no rows is absent
   *  and reads as zero. */
  private async countRowsCreatedPerDay(
    entity: EntityTarget<ObjectLiteral>,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.dataSource
      .createQueryBuilder(entity, 'row')
      .select(CREATED_DAY_EXPRESSION, 'day')
      .addSelect('COUNT(*)', 'total')
      .where('row.createdAt >= :rangeStart', { rangeStart })
      .andWhere('row.createdAt < :rangeEnd', { rangeEnd })
      .groupBy(CREATED_DAY_EXPRESSION)
      .getRawMany<{ day: string; total: string }>();

    const createdPerDay = new Map<string, number>();
    for (const row of rows) {
      createdPerDay.set(row.day, Number(row.total));
    }
    return createdPerDay;
  }
}
