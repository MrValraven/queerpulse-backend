import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One hero stat tile above the roadmap columns, e.g. `{ label: "12 shipped
 *  this year", jade: true }`. Mirrors the frontend's `HERO_STATS` shape in
 *  `queerpulse/src/features/marketing/roadmap.data.ts`. */
export interface HeroStat {
  label: string;
  jade?: boolean;
}

/**
 * Singleton (id = 1) holding the roadmap's admin-curated hero stats, mirrors
 * `governance_overview`/`changemaker_directory_settings`: one row, no
 * authoring endpoint beyond an admin edit, read by `GET /roadmap`.
 */
@Entity('roadmap_settings')
export class RoadmapSettings {
  @PrimaryColumn({ type: 'int', default: 1 })
  id: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  heroStats: HeroStat[];

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
