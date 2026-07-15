import {
  FinanceEventNote,
  FinanceLine,
  FinanceStat,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';

export interface GovernanceFinanceResponseDTO {
  quarter: string;
  stats: FinanceStat[];
  income: FinanceLine[];
  expense: FinanceLine[];
  eventNotes: FinanceEventNote[];
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
    publishedAt: report.publishedAt.toISOString(),
  };
}
