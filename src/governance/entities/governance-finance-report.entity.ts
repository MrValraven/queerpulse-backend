import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** A single stat tile, e.g. `{ n: "€4,150", l: "Total expenditure", trend:
 *  "Within budget", up: false }` — mirrors the frontend's `FIN_STATS` shape
 *  in `queerpulse/src/features/governance/governance.data.ts`. */
export interface FinanceStat {
  n: string;
  l: string;
  trend: string;
  up: boolean;
}

export interface FinanceLineItem {
  name: string;
  period: string;
  amount: string;
}

export interface FinanceLineTotal {
  label: string;
  amount: string;
}

/** One expandable income/expense row, e.g. "Member contributions — €1,840".
 *  Mirrors the frontend's `FinLine` interface exactly (including the
 *  formatted `amount` strings and the `width` percentage that drives the
 *  bar-fill visual — kept as-is rather than re-derived, since it's curated
 *  editorial framing of the same figures, not a separate fact). */
export interface FinanceLine {
  label: string;
  amount: string;
  note: string;
  width: number;
  items: FinanceLineItem[];
  total: FinanceLineTotal;
}

/** One "how event finances work" bullet, e.g. `["Hosts keep 100% of ticket
 *  sales.", "QueerPulse charges no platform fee. …"]` in the frontend's
 *  `EVENTS` tuple array — reshaped to a named object for a stable JSON
 *  contract. */
export interface FinanceEventNote {
  title: string;
  body: string;
}

/**
 * A published quarterly financial-transparency snapshot — backs
 * `GET /governance/finances` (see `src/governance/`), read by
 * `GovernanceFinance.tsx` / `GovernanceSections.tsx`'s `FinancesSection`.
 * Read-only + seeded (mirrors the `resources` module's pattern): there is no
 * authoring endpoint here, only a quarterly seed a maintainer would insert.
 *
 * The nested breakdowns (`stats`/`income`/`expense`/`eventNotes`) are stored
 * as `jsonb` rather than normalized into child tables — like `Draft.payload`
 * — because they're a single cohesive published document (a quarter's
 * figures don't get edited row-by-row; a new quarter is a new report), and
 * the frontend renders them as one nested tree with no independent query
 * needs of its own.
 */
@Entity('governance_finance_report')
export class GovernanceFinanceReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // e.g. "2026-Q2". One published report per quarter.
  @Index('UQ_governance_finance_report_quarter', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  quarter: string;

  @Column({ type: 'jsonb' })
  stats: FinanceStat[];

  @Column({ type: 'jsonb' })
  income: FinanceLine[];

  @Column({ type: 'jsonb' })
  expense: FinanceLine[];

  @Column({ type: 'jsonb', name: 'event_notes' })
  eventNotes: FinanceEventNote[];

  @Column({ type: 'timestamptz', name: 'published_at' })
  publishedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
