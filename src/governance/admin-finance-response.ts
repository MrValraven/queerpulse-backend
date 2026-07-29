import {
  FinanceLine,
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
}

export interface AdminFinanceResponseDTO {
  latest: AdminFinanceLatest | null;
  history: AdminFinanceHistoryPoint[];
}

export function toAdminFinanceLatest(
  report: GovernanceFinanceReport,
): AdminFinanceLatest {
  return {
    quarter: report.quarter,
    incomeTotal: report.incomeTotal ?? 0,
    expenseTotal: report.expenseTotal ?? 0,
    surplus: report.surplus ?? 0,
    mrr: report.mrr ?? 0,
    sustainerCount: report.sustainerCount ?? 0,
    solidarityRate: report.solidarityRate ?? 0,
    income: report.income ?? [],
    expense: report.expense ?? [],
    publishedAt: report.publishedAt.toISOString(),
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
