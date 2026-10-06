import { MemberRef } from '../common/member-ref';
import {
  FinanceEventNote,
  FinanceLine,
  FinanceMetricSource,
  FinancePartner,
  FinanceReserve,
  FinanceStat,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';
import { isEnteredByPeople } from './governance-finance-response';

// Backs `GET /admin/governance/finances` — the admin governance Finances tab
// (`/admin/governance`). Unlike `GovernanceFinanceResponseDTO` (the public
// `/governance/finances` snapshot for one quarter), this response bundles the
// latest quarter's full metrics + ledgers alongside a lightweight historical
// series across all published quarters, for the tab's trend chart.

export interface AdminFinanceHistoryPoint {
  quarter: string;
  incomeTotal: number;
  expenseTotal: number;
  surplus: number;
}

/**
 * Provenance of each editable scalar, so the tab can badge which figures are
 * trustworthy. `surplus` is always `computed` (it is derived from the two
 * totals, never stored or edited directly).
 */
export interface AdminFinanceSources {
  mrr: FinanceMetricSource;
  sustainerCount: FinanceMetricSource;
  solidarityRate: FinanceMetricSource;
  incomeTotal: FinanceMetricSource;
  expenseTotal: FinanceMetricSource;
  surplus: FinanceMetricSource;
}

export interface AdminFinanceLatest {
  quarter: string;
  /** The five editable headline figures are null when nobody has entered
   *  them yet (a freshly opened quarter), so the editor can show an empty
   *  field and an entered 0 is still an entry. */
  incomeTotal: number | null;
  expenseTotal: number | null;
  surplus: number;
  mrr: number | null;
  sustainerCount: number | null;
  solidarityRate: number | null;
  income: FinanceLine[];
  expense: FinanceLine[];
  /** PRD-447. The public report's tiles, notes and disclosures, editable on
   *  the tab so none of them needs SQL. */
  stats: FinanceStat[];
  eventNotes: FinanceEventNote[];
  partners: FinancePartner[];
  reserve: FinanceReserve | null;
  /** PRD-447. Whether `GET /governance/finances` serves this report: true
   *  once none of the five headline figures still reads `seeded`. */
  isPublic: boolean;
  publishedAt: string;
  /** Provenance badge state for each editable scalar. */
  sources: AdminFinanceSources;
  /** Who last edited any metric on this report, resolved to a display ref;
   *  null when nothing has been edited (or the editor's account is gone). */
  editor: MemberRef | null;
  /** When any metric was last edited (ISO); null when never edited. */
  editedAt: string | null;
}

export interface AdminFinanceResponseDTO {
  latest: AdminFinanceLatest | null;
  history: AdminFinanceHistoryPoint[];
}

/** Fills a concrete `source` and `enabled` on every ledger row so the
 *  frontend never has to treat them as optional: rows seeded before
 *  provenance tracking read `seeded`, and rows never toggled read enabled. */
function withLineSource(lines: FinanceLine[]): FinanceLine[] {
  return lines.map((line) => ({
    ...line,
    source: line.source ?? FinanceMetricSource.Seeded,
    enabled: line.enabled ?? true,
  }));
}

export function toAdminFinanceLatest(
  report: GovernanceFinanceReport,
  editor: MemberRef | null,
): AdminFinanceLatest {
  return {
    quarter: report.quarter,
    incomeTotal: report.incomeTotal,
    expenseTotal: report.expenseTotal,
    surplus: report.surplus ?? 0,
    mrr: report.mrr,
    sustainerCount: report.sustainerCount,
    solidarityRate: report.solidarityRate,
    income: withLineSource(report.income ?? []),
    expense: withLineSource(report.expense ?? []),
    stats: report.stats ?? [],
    eventNotes: report.eventNotes ?? [],
    partners: report.partners ?? [],
    reserve: report.reserve ?? null,
    isPublic: isEnteredByPeople(report),
    publishedAt: report.publishedAt.toISOString(),
    sources: {
      mrr: report.mrrSource,
      sustainerCount: report.sustainerCountSource,
      solidarityRate: report.solidarityRateSource,
      incomeTotal: report.incomeTotalSource,
      expenseTotal: report.expenseTotalSource,
      surplus: FinanceMetricSource.Computed,
    },
    editor,
    editedAt: report.metricsEditedAt?.toISOString() ?? null,
  };
}

/** The chart series. A quarter whose totals nobody has entered yet (a freshly
 *  opened one) is left out, so it never plots as a real €0 (PRD-447). */
export function toAdminFinanceHistory(
  reports: GovernanceFinanceReport[],
): AdminFinanceHistoryPoint[] {
  return reports
    .filter(
      (report) => report.incomeTotal !== null || report.expenseTotal !== null,
    )
    .map((report) => ({
      quarter: report.quarter,
      incomeTotal: report.incomeTotal ?? 0,
      expenseTotal: report.expenseTotal ?? 0,
      surplus: report.surplus ?? 0,
    }));
}
