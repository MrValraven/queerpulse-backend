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
    publishedAt: report.publishedAt.toISOString(),
  };
}
