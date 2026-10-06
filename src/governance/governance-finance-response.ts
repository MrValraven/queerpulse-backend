import {
  FinanceEventNote,
  FinanceLine,
  FinanceMetricSource,
  FinancePartner,
  FinanceReserve,
  FinanceStat,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';

/**
 * Where the published figures came from (PRD-447). The public page labels the
 * report with it ("Figures entered by the governance team on {date}"). Only a
 * report whose headline figures were all entered by people reaches the public
 * endpoint (see {@link isEnteredByPeople}), so `source` reads `manual` today;
 * it is carried as the enum so a later `computed` report needs no new field.
 */
export interface GovernanceFinanceProvenanceDTO {
  source: FinanceMetricSource;
  /** ISO-8601: when a person last saved figures on this report. */
  enteredAt: string;
}

/**
 * `GET /governance/finances`. Every field a report fills is nullable or an
 * empty array, so "no report published yet" travels in the same shape:
 * `quarter`, `publishedAt` and `provenance` are null and every list is empty.
 */
export interface GovernanceFinanceResponseDTO {
  quarter: string | null;
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
  publishedAt: string | null;
  provenance: GovernanceFinanceProvenanceDTO | null;
}

/** The provenance columns of the five headline figures. */
export const HEADLINE_SOURCE_KEYS = [
  'mrrSource',
  'sustainerCountSource',
  'solidarityRateSource',
  'incomeTotalSource',
  'expenseTotalSource',
] as const;

/**
 * PRD-447. A report is public once every headline figure on it was entered by
 * a person: none of the five provenance columns still reads `seeded`. A
 * freshly opened quarter, or a seeded row an admin only half corrected, stays
 * on the admin tab until the last figure is in.
 */
export function isEnteredByPeople(report: GovernanceFinanceReport): boolean {
  return HEADLINE_SOURCE_KEYS.every(
    (sourceKey) => report[sourceKey] !== FinanceMetricSource.Seeded,
  );
}

/**
 * The ledger as the public page gets it. A row an admin switched off is left
 * out. Every row also loses its line-item breakdown and total label: no admin
 * path writes those, so whatever they hold came from the seed (named funders,
 * real vendors, an invented member count). The row's own label, amount and
 * note are what the governance team entered.
 */
function shownLines(lines: FinanceLine[]): FinanceLine[] {
  return lines
    .filter((line) => line.enabled !== false)
    .map((line) => ({
      ...line,
      items: [],
      total: { label: '', amount: line.total?.amount ?? line.amount },
    }));
}

/** A partner reaches the public page once a person entered it: the admin typed
 *  its restriction (`scope`), or saved it through the editor with its
 *  translated `scopeKey` kept (`source: manual`). A partner carrying only an
 *  i18n `scopeKey` and no marker is a seeded row. Hand-mapped, so the internal
 *  `source` marker stays off the public response. */
function enteredPartners(partners: FinancePartner[] | null): FinancePartner[] {
  return (partners ?? [])
    .filter(
      (partner) =>
        Boolean(partner.scope) ||
        (Boolean(partner.scopeKey) &&
          partner.source === FinanceMetricSource.Manual),
    )
    .map((partner) => ({
      name: partner.name,
      amount: partner.amount,
      ...(partner.scopeKey ? { scopeKey: partner.scopeKey } : {}),
      ...(partner.scope ? { scope: partner.scope } : {}),
    }));
}

/** The "nothing published yet" response. */
export function toEmptyGovernanceFinanceResponse(): GovernanceFinanceResponseDTO {
  return {
    quarter: null,
    stats: [],
    income: [],
    expense: [],
    eventNotes: [],
    reserve: null,
    partners: [],
    incomeTotal: null,
    expenseTotal: null,
    surplus: null,
    mrr: null,
    sustainerCount: null,
    solidarityRate: null,
    publishedAt: null,
    provenance: null,
  };
}

export function toGovernanceFinanceResponse(
  report: GovernanceFinanceReport,
): GovernanceFinanceResponseDTO {
  const enteredAt = report.metricsEditedAt ?? report.updatedAt;
  return {
    quarter: report.quarter,
    stats: report.stats,
    income: shownLines(report.income),
    expense: shownLines(report.expense),
    eventNotes: report.eventNotes,
    reserve: report.reserve ?? null,
    // Always an array, so the frontend can map over `partners` unguarded.
    partners: enteredPartners(report.partners),
    incomeTotal: report.incomeTotal ?? null,
    expenseTotal: report.expenseTotal ?? null,
    surplus: report.surplus ?? null,
    mrr: report.mrr ?? null,
    sustainerCount: report.sustainerCount ?? null,
    solidarityRate: report.solidarityRate ?? null,
    publishedAt: report.publishedAt.toISOString(),
    provenance: {
      source: isEnteredByPeople(report)
        ? FinanceMetricSource.Manual
        : FinanceMetricSource.Seeded,
      enteredAt: enteredAt.toISOString(),
    },
  };
}
