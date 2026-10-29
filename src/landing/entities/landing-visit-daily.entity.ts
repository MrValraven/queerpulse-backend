import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
import type { LandingVisitPage } from '../landing-visit-source';

/**
 * One row per (UTC calendar day, page, normalized source): the only durable
 * trace of a landing page visit.
 *
 * Holds no IP, no user agent, no cookie, no member id and no time of day. The
 * most granular fact recoverable from this table is "the landing page had 41
 * visits from instagram on 2026-10-26", so there is no data subject in it.
 */
@Entity('landing_visit_daily')
@Check('CHK_landing_visit_daily_page', `"page" IN ('home', 'studio')`)
export class LandingVisitDaily {
  /** UTC calendar day, `YYYY-MM-DD`. `date` comes back as a string. */
  @PrimaryColumn({ type: 'date' })
  day!: string;

  /** The page that was visited: `home` or `studio`. */
  @PrimaryColumn({ type: 'varchar', length: 16, default: 'home' })
  page!: LandingVisitPage;

  /** Output of `normalizeLandingSource`: `[a-z0-9._-]`, at most 64 chars. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'integer', default: 0 })
  visits!: number;
}
