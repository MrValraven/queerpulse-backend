import { Injectable } from '@nestjs/common';
import { FeatureKey } from '../launchedFeatures';

/**
 * The in-memory half of reach. Holds counts since the last flush and nothing
 * else: no identity, no route, no timestamp.
 *
 * A process crash loses at most one flush interval. That is immaterial at the
 * resolution this feeds, which is deciding where to spend the next month.
 */
@Injectable()
export class FeatureUsageTallyService {
  private readonly pendingCounts = new Map<FeatureKey, number>();

  record(featureKey: FeatureKey): void {
    this.pendingCounts.set(
      featureKey,
      (this.pendingCounts.get(featureKey) ?? 0) + 1,
    );
  }

  /** Takes everything pending and clears it, ready for the next interval. */
  drain(): Map<FeatureKey, number> {
    const drained = new Map(this.pendingCounts);
    this.pendingCounts.clear();
    return drained;
  }

  /**
   * Puts drained counts back after a flush failed, ADDING to whatever has
   * arrived since rather than overwriting it, so requests that landed during
   * the failed write are not thrown away.
   */
  restore(tallies: Map<FeatureKey, number>): void {
    for (const [featureKey, count] of tallies) {
      this.pendingCounts.set(
        featureKey,
        (this.pendingCounts.get(featureKey) ?? 0) + count,
      );
    }
  }
}
