import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One hero stat tile above the roadmap columns, e.g. `{ label: "12 shipped
 *  this year", value: "12", note: "since launch", jade: true }`. Mirrors the
 *  frontend's `HERO_STATS` shape in
 *  `queerpulse/src/features/marketing/roadmap.data.ts`. `value`/`note` were
 *  added in Task A3 for the redesigned admin Hero Stats view (a big number
 *  plus a small caption alongside the existing label); both stay optional so
 *  older seeded stats (label-only) keep validating. */
export interface HeroStat {
  label: string;
  value?: string;
  note?: string;
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
  id!: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  heroStats!: HeroStat[];

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
