import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per (calendar day, feature). The ONLY durable artifact of reach.
 *
 * Deliberately holds no URL, no member id, no session id, no ordering and no
 * time of day. The most granular fact recoverable from this table is
 * "housingListings was requested 812 times on 2026-09-04". That property is
 * what keeps it outside DSAR scope: there is no data subject in it, so there
 * is nothing to export and nothing to erase.
 */
@Entity('feature_usage_daily')
export class FeatureUsageDaily {
  /** UTC calendar day, `YYYY-MM-DD`. `date` comes back as a string. */
  @PrimaryColumn({ type: 'date' })
  day!: string;

  /** A `FeatureKey` from `src/launchedFeatures.ts`. Never a route path. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  featureKey!: string;

  @Column({ type: 'integer', default: 0 })
  requestCount!: number;
}
