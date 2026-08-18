import { MemberRef } from '../common/member-ref';
import {
  FinanceLine,
  FinanceMetricSource,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';

// Backs `GET /governance/admin/finances` — the admin governance Finances tab
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
  incomeTotal: number;
  expenseTotal: number;
  surplus: number;
  mrr: number;
  sustainerCount: number;
  solidarityRate: number;
  income: FinanceLine[];
  expense: FinanceLine[];
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
    incomeTotal: report.incomeTotal ?? 0,
    expenseTotal: report.expenseTotal ?? 0,
    surplus: report.surplus ?? 0,
    mrr: report.mrr ?? 0,
    sustainerCount: report.sustainerCount ?? 0,
    solidarityRate: report.solidarityRate ?? 0,
    income: withLineSource(report.income ?? []),
    expense: withLineSource(report.expense ?? []),
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

export function toAdminFinanceHistory(
  reports: GovernanceFinanceReport[],
): AdminFinanceHistoryPoint[] {
  return reports.map((report) => ({
    quarter: report.quarter,
    incomeTotal: report.incomeTotal ?? 0,
    expenseTotal: report.expenseTotal ?? 0,
    surplus: report.surplus ?? 0,
  }));
}
