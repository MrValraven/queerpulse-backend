import {
  FinanceEventNote,
  FinanceLine,
  FinancePartner,
  FinanceReserve,
  FinanceStat,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';

export interface GovernanceFinanceResponseDTO {
  quarter: string;
  stats: FinanceStat[];
  income: FinanceLine[];
  expense: FinanceLine[];
  eventNotes: FinanceEventNote[];
  reserve: FinanceReserve | null;
  partners: FinancePartner[];
  incomeTotal?: number | null;
  expenseTotal?: number | null;
  surplus?: number | null;
  mrr?: number | null;
  sustainerCount?: number | null;
  solidarityRate?: number | null;
  publishedAt: string;
}

export function toGovernanceFinanceResponse(
  report: GovernanceFinanceReport,
): GovernanceFinanceResponseDTO {
  return {
    quarter: report.quarter,
    stats: report.stats,
    income: report.income,
    expense: report.expense,
    eventNotes: report.eventNotes,
    reserve: report.reserve ?? null,
    // Normalize a null column to an empty array so the frontend can always map
    // over `partners` without a guard.
    partners: report.partners ?? [],
    incomeTotal: report.incomeTotal ?? null,
    expenseTotal: report.expenseTotal ?? null,
    surplus: report.surplus ?? null,
    mrr: report.mrr ?? null,
    sustainerCount: report.sustainerCount ?? null,
    solidarityRate: report.solidarityRate ?? null,
    publishedAt: report.publishedAt.toISOString(),
  };
}
