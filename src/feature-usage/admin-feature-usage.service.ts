import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityTarget,
  MoreThan,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingSavedSearch } from '../housing-saved-searches/entities/housing-saved-search.entity';
import { HousingViewing } from '../housing-viewings/entities/housing-viewing.entity';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { FeatureKey, launchedFeatures } from '../launchedFeatures';
import { FEATURE_DEPTH } from './feature-depth';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';
import {
  AdminFeatureUsageDTO,
  classifyFeatures,
  FeatureUsageRow,
  FeatureUsageState,
  hasReachSignal,
} from './feature-usage-response';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Caps the fan-out of per-entity depth counts against the shared pool.
 * `FEATURE_DEPTH` names 26 entities across its `rows`-kind features, each
 * queried at two cutoffs (`depth` and `depthTotal`), plus 7 drill-down
 * counts, for roughly 59 queries issued through this one cap rather than a
 * bare `Promise.all`. Mirrors `MAX_CONCURRENT_QUEUE_COUNTS` in
 * `admin-queues.service.ts`.
 */
const MAX_CONCURRENT_USAGE_COUNTS = 6;

/**
 * Sort position for each classification, most in-need-of-a-decision first: a
 * healthy-reach feature with nothing created is the strongest signal
 * something is broken or undiscoverable, a quiet feature is a softer version
 * of the same question, a busy feature needs no attention, and an unlaunched
 * feature carries no traffic by construction.
 */
const STATE_SORT_ORDER: Record<FeatureUsageState, number> = {
  'browsed-but-empty': 0,
  quiet: 1,
  busy: 2,
  'not-launched': 3,
};

/** `feature_usage_daily.day` is a `date` column; compares correctly against a
 *  bare `YYYY-MM-DD` string taken from a UTC instant. */
function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on `date`'s own calendar day. Used to anchor every window in
 *  `getUsage` to a whole-day boundary, rather than the exact instant the
 *  request happened to arrive. */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** The feature key and cutoff kind for one entity's depth count. The entity
 *  itself is not carried here: it lives only in the matching closure pushed
 *  onto `depthCountThunks` at the same index. `depthCountTasks[i]`,
 *  `depthCountThunks[i]`, and therefore `depthCountResults[i]` are pushed in
 *  lockstep below and must stay aligned by index, which is what lets the
 *  results be folded back onto the right feature key afterward. Kept as a
 *  flat list of single-entity, single-cutoff tasks (rather than one task per
 *  feature summing across its entities) so `runWithConcurrency`'s cap bounds
 *  the true number of simultaneous queries rather than the coarser count of
 *  features. */
interface DepthCountTask {
  featureKey: FeatureKey;
  kind: 'depth' | 'depthTotal';
}

interface DepthTotals {
  depth: number;
  depthTotal: number;
}

/**
 * Read model behind the admin feature-usage panel: for every product
 * feature, how many requests it reached (`reach`) and, where the feature has
 * a member-authored entity to count, how many rows a member actually created
 * (`depth`). `AdminFeatureUsageService.getUsage` assembles both signals into
 * one `AdminFeatureUsageDTO`, classifies every feature with `classifyFeatures`,
 * and orders the result so the states that most need a human decision sort
 * first.
 *
 * `depth` is reconstructed historically rather than tallied going forward:
 * every count is `created_at < cutoff` against the entity's own table, which
 * works for a date range entirely before this feature shipped because the
 * rows that answer it were already there. `reach`, by contrast, has no
 * history before `feature_usage_daily` started being written, since nothing
 * durable recorded a request before that.
 *
 * DAY-BOUNDARY CONVENTION: `reach` is stored in whole UTC calendar days
 * (`feature_usage_daily.day`), so every window this service computes is
 * anchored to UTC midnight rather than the exact instant the request
 * happened to arrive. `rangeEnd` is midnight UTC at the START of today, and
 * it is EXCLUSIVE on every predicate that uses it (`< rangeEnd` for reach,
 * `depth`, `depthTotal`, and the range-scoped drill-downs): today itself,
 * still partial, is outside every range. `rangeStart` is `rangeEnd` minus
 * `rangeDays` whole days and is INCLUSIVE (`>= rangeStart`). `depthTotal`
 * reads "rows in existence at the end of the range" as `created_at <
 * rangeEnd`, the same exclusive boundary reach and depth already use, so a
 * feature's depth and depthTotal for a given day are always computed from
 * counts of full days and never mix a partial day into one side only.
 */
@Injectable()
export class AdminFeatureUsageService {
  constructor(
    @InjectRepository(FeatureUsageDaily)
    private readonly featureUsageDailies: Repository<FeatureUsageDaily>,
    private readonly dataSource: DataSource,
  ) {}

  async getUsage(rangeDays: number): Promise<AdminFeatureUsageDTO> {
    const rangeEnd = startOfUtcDay(new Date());
    const rangeStart = new Date(
      rangeEnd.getTime() - rangeDays * MILLISECONDS_PER_DAY,
    );
    const previousRangeStart = new Date(
      rangeStart.getTime() - rangeDays * MILLISECONDS_PER_DAY,
    );

    const [reachByFeature, previousReachByFeature] = await Promise.all([
      this.sumRequestsByFeature(rangeStart, rangeEnd),
      this.sumRequestsByFeature(previousRangeStart, rangeStart),
    ]);

    const featureKeys = Object.keys(FEATURE_DEPTH) as FeatureKey[];

    const depthCountTasks: DepthCountTask[] = [];
    const depthCountThunks: Array<() => Promise<number>> = [];
    for (const featureKey of featureKeys) {
      const spec = FEATURE_DEPTH[featureKey];
      if (spec.kind !== 'rows') continue;
      for (const entity of spec.entities) {
        depthCountTasks.push({ featureKey, kind: 'depth' });
        depthCountThunks.push(() =>
          this.countRowsCreatedInRange(entity, rangeStart, rangeEnd),
        );
        depthCountTasks.push({ featureKey, kind: 'depthTotal' });
        depthCountThunks.push(() =>
          this.countRowsCreatedBefore(entity, rangeEnd),
        );
      }
    }

    // Every drill-down count is scoped to the SAME `[rangeStart, rangeEnd)`
    // window as `depth`, so the panel answers one question throughout: "what
    // happened in the selected range". The one exception is
    // `communitiesStillPostingThisWeekCount` below, which deliberately does
    // NOT use this window; see its own comment.
    const drillDownThunks: Array<() => Promise<number>> = [
      () => this.countRowsCreatedInRange(HousingListing, rangeStart, rangeEnd),
      () =>
        this.countRowsCreatedInRange(HousingSavedSearch, rangeStart, rangeEnd),
      () => this.countRowsCreatedInRange(HousingViewing, rangeStart, rangeEnd),
      () => this.countRowsCreatedInRange(ForumThread, rangeStart, rangeEnd),
      () => this.countRowsCreatedInRange(ForumPost, rangeStart, rangeEnd),
      () => this.countRowsCreatedInRange(Community, rangeStart, rangeEnd),
      // NOT range-scoped, deliberately. `activeThisWeek` is a ROLLING seven
      // days maintained by `CommunityActivityCounterService`'s hourly job,
      // measured back from whenever that job last ran, independent of
      // `rangeEnd`. Recomputing it over `[rangeStart, rangeEnd)` here would
      // duplicate a definition that already has one owner and could disagree
      // with the same figure shown elsewhere in the admin surface. The DTO
      // field is named `stillPostingThisWeek` so the rolling window is
      // explicit in the field name.
      () =>
        this.dataSource
          .getRepository(Community)
          .count({ where: { activeThisWeek: MoreThan(0) } }),
    ];

    const allResults = await runWithConcurrency(
      [...depthCountThunks, ...drillDownThunks],
      MAX_CONCURRENT_USAGE_COUNTS,
    );
    const depthCountResults = allResults.slice(0, depthCountThunks.length);
    const [
      housingListingsCount,
      housingSavedSearchesCount,
      housingViewingsCount,
      forumThreadsCount,
      forumRepliesCount,
      communitiesCreatedCount,
      communitiesStillPostingThisWeekCount,
    ] = allResults.slice(depthCountThunks.length);

    const depthByFeature = new Map<FeatureKey, DepthTotals>();
    depthCountTasks.forEach((task, index) => {
      const totals = depthByFeature.get(task.featureKey) ?? {
        depth: 0,
        depthTotal: 0,
      };
      totals[task.kind] += depthCountResults[index] ?? 0;
      depthByFeature.set(task.featureKey, totals);
    });

    const rows: FeatureUsageRow[] = featureKeys.map((featureKey) => {
      const spec = FEATURE_DEPTH[featureKey];
      const isLaunched = launchedFeatures[featureKey].launched;
      const reach = reachByFeature.get(featureKey) ?? 0;
      const reachPrevious = previousReachByFeature.get(featureKey) ?? 0;

      if (spec.kind === 'reach-only') {
        return {
          featureKey,
          isLaunched,
          reach,
          depth: null,
          depthTotal: null,
          reachPrevious,
          reason: spec.reason,
        };
      }

      const totals = depthByFeature.get(featureKey) ?? {
        depth: 0,
        depthTotal: 0,
      };
      return {
        featureKey,
        isLaunched,
        reach,
        depth: totals.depth,
        depthTotal: totals.depthTotal,
        reachPrevious,
        reason: null,
      };
    });

    const features = classifyFeatures(rows).sort((first, second) => {
      const stateOrderDelta =
        STATE_SORT_ORDER[first.state] - STATE_SORT_ORDER[second.state];
      if (stateOrderDelta !== 0) return stateOrderDelta;
      return second.reach - first.reach;
    });

    return {
      rangeDays,
      hasReachSignal: hasReachSignal(rows),
      features,
      drillDowns: {
        housingListings: {
          listings: housingListingsCount ?? 0,
          savedSearches: housingSavedSearchesCount ?? 0,
          viewings: housingViewingsCount ?? 0,
        },
        forum: {
          threads: forumThreadsCount ?? 0,
          replies: forumRepliesCount ?? 0,
        },
        communities: {
          created: communitiesCreatedCount ?? 0,
          stillPostingThisWeek: communitiesStillPostingThisWeekCount ?? 0,
        },
      },
    };
  }

  /** Sums `requestCount` from `feature_usage_daily`, grouped by feature key,
   *  over `[start, end)`. One grouped query, covering every feature at once. */
  private async sumRequestsByFeature(
    start: Date,
    end: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.featureUsageDailies
      .createQueryBuilder('daily')
      .select('daily.featureKey', 'featureKey')
      .addSelect('SUM(daily.requestCount)', 'total')
      .where('daily.day >= :start', { start: toDateOnlyString(start) })
      .andWhere('daily.day < :end', { end: toDateOnlyString(end) })
      .groupBy('daily.featureKey')
      .getRawMany<{ featureKey: string; total: string }>();

    return new Map(rows.map((row) => [row.featureKey, Number(row.total)]));
  }

  /** Rows of `entity` created inside `[rangeStart, rangeEnd)`, the `depth`
   *  half of a `rows`-kind feature. */
  private countRowsCreatedInRange(
    entity: EntityTarget<ObjectLiteral>,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<number> {
    return this.dataSource
      .createQueryBuilder(entity, 'row')
      .where('row.createdAt >= :rangeStart', { rangeStart })
      .andWhere('row.createdAt < :rangeEnd', { rangeEnd })
      .getCount();
  }

  /** Rows of `entity` in existence at `cutoff` (`created_at < cutoff`), the
   *  `depthTotal` half of a `rows`-kind feature. Works for a cutoff before
   *  this feature ever shipped, because the rows it counts were already
   *  there. */
  private countRowsCreatedBefore(
    entity: EntityTarget<ObjectLiteral>,
    cutoff: Date,
  ): Promise<number> {
    return this.dataSource
      .createQueryBuilder(entity, 'row')
      .where('row.createdAt < :cutoff', { cutoff })
      .getCount();
  }
}
