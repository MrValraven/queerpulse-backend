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

/**
 * Where a finance figure came from, so the admin Finances tab can flag which
 * numbers are trustworthy and which are placeholders:
 *  - `seeded`   — inserted by the quarterly seed and never verified by a human.
 *  - `manual`   — an admin typed this value (see `metricsEditedBy`/`At`).
 *  - `computed` — derived from other figures, not directly editable (surplus).
 */
export enum FinanceMetricSource {
  Seeded = 'seeded',
  Manual = 'manual',
  Computed = 'computed',
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
  /** Provenance of this ledger row's `amount`. Absent on seeded rows written
   *  before provenance tracking existed — read as {@link FinanceMetricSource.Seeded}. */
  source?: FinanceMetricSource;
  /** Whether this row renders on the admin Finances tab. Absent means enabled
   *  — an admin turns a row off when it doesn't apply to this org (e.g. no
   *  partner support this quarter) rather than deleting its history. */
  enabled?: boolean;
}

/** One "how event finances work" bullet, e.g. `["Hosts keep 100% of ticket
 *  sales.", "QueerPulse charges no platform fee. …"]` in the frontend's
 *  `EVENTS` tuple array — reshaped to a named object for a stable JSON
 *  contract. */
export interface FinanceEventNote {
  title: string;
  body: string;
}

/** The operational-reserve progress figures rendered under the income/expense
 *  breakdown ("€4,380 of €12,450 target"). Raw numbers — the frontend formats
 *  them with `useFormat().currency()`, never pre-baked strings. */
export interface FinanceReserve {
  current: number;
  target: number;
}

/** One disclosed restricted-grant partner ("Fundação Calouste Gulbenkian —
 *  €400 · Mental Health Fund"). `name`/`amount` are non-translatable data;
 *  `scopeKey` is the i18n key for the restriction description. Mirrors the
 *  frontend's `FinancePartner` shape. */
export interface FinancePartner {
  name: string;
  amount: number;
  scopeKey: string;
}

/**
 * Postgres `numeric` columns round-trip as strings through `pg` by default
 * (arbitrary precision, so the driver never silently narrows them) — this
 * transformer keeps the metric columns below as `number | null` on the
 * entity, matching the same pattern used by `Job`'s and `Workshop`'s
 * `numericTransformer` (kept file-local rather than shared, per those
 * entities' own precedent).
 */
const numericTransformer = {
  to: (value: number | null | undefined): number | null => value ?? null,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

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
  id!: string;

  // e.g. "2026-Q2". One published report per quarter.
  @Index('UQ_governance_finance_report_quarter', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  quarter!: string;

  @Column({ type: 'jsonb' })
  stats!: FinanceStat[];

  @Column({ type: 'jsonb' })
  income!: FinanceLine[];

  @Column({ type: 'jsonb' })
  expense!: FinanceLine[];

  @Column({ type: 'jsonb' })
  eventNotes!: FinanceEventNote[];

  // Reserve progress + disclosed partners render inside `FinancesSection`
  // alongside the income/expense breakdown, and (like the reserve total) they
  // shift quarter to quarter, so they live on the quarterly report rather than
  // the evergreen `governance_overview`. Added after the initial table, hence
  // nullable — the seeded Q2 2026 row is backfilled by the seed.
  @Column({ type: 'jsonb', nullable: true })
  reserve!: FinanceReserve | null;

  @Column({ type: 'jsonb', nullable: true })
  partners!: FinancePartner[] | null;

  // Numeric per-quarter totals + MRR figures backing the admin governance
  // Finances tab (`/admin/governance` → Finances). Nullable — added after the
  // initial table, alongside `reserve`/`partners`, and not yet backfilled for
  // every historical quarter.
  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  incomeTotal!: number | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  expenseTotal!: number | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  surplus!: number | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  mrr!: number | null;

  @Column({ type: 'int', nullable: true })
  sustainerCount!: number | null;

  @Column({
    type: 'numeric',
    nullable: true,
    transformer: numericTransformer,
  })
  solidarityRate!: number | null;

  // Per-metric provenance for the five editable scalars above. One shared
  // Postgres enum type backs all five columns (they share the same three
  // states). `surplus` has no column: it is always derived from
  // `income_total - expense_total`, so its provenance is a constant `computed`
  // reported by the DTO, never stored. Default `seeded` so every existing
  // (seed-inserted) row is honestly labelled until an admin edits it.
  @Column({
    type: 'enum',
    enum: FinanceMetricSource,
    enumName: 'governance_finance_report_source_enum',
    default: FinanceMetricSource.Seeded,
  })
  mrrSource!: FinanceMetricSource;

  @Column({
    type: 'enum',
    enum: FinanceMetricSource,
    enumName: 'governance_finance_report_source_enum',
    default: FinanceMetricSource.Seeded,
  })
  sustainerCountSource!: FinanceMetricSource;

  @Column({
    type: 'enum',
    enum: FinanceMetricSource,
    enumName: 'governance_finance_report_source_enum',
    default: FinanceMetricSource.Seeded,
  })
  solidarityRateSource!: FinanceMetricSource;

  @Column({
    type: 'enum',
    enum: FinanceMetricSource,
    enumName: 'governance_finance_report_source_enum',
    default: FinanceMetricSource.Seeded,
  })
  incomeTotalSource!: FinanceMetricSource;

  @Column({
    type: 'enum',
    enum: FinanceMetricSource,
    enumName: 'governance_finance_report_source_enum',
    default: FinanceMetricSource.Seeded,
  })
  expenseTotalSource!: FinanceMetricSource;

  // Who last edited any metric on this report, and when. `ON DELETE SET NULL`
  // (added in the migration, like `platform_settings.updated_by`) so the
  // pointer survives erasure of the editor's account. The precise per-field
  // trail lives in `governance_finance_changes`; this is only the badge's
  // "last edited by X on <date>".
  @Column({ type: 'uuid', nullable: true })
  metricsEditedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  metricsEditedAt!: Date | null;

  @Index('IDX_governance_finance_report_published_at')
  @Column({ type: 'timestamptz' })
  publishedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
