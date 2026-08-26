import { TransparencyPeriodDTO } from './transparency-response';

/**
 * The Transparency Report's reporting period: a calendar quarter, in UTC.
 *
 * Quarters, rather than the rolling week windows the admin dashboards use,
 * because a published document needs a boundary a reader can name and return
 * to. A rolling window silently changes what it covers between two visits, so
 * two readers quoting "the report" would be quoting different numbers. It also
 * matches the quarter the governance finances are already published on, so the
 * two governance surfaces divide time the same way.
 */
export interface TransparencyPeriod {
  id: string;
  year: number;
  quarter: number;
  /** Inclusive. */
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
}

function quarterOfMonth(monthIndex: number): number {
  return Math.floor(monthIndex / 3) + 1;
}

function buildPeriod(year: number, quarter: number): TransparencyPeriod {
  const startMonthIndex = (quarter - 1) * 3;
  return {
    id: `${year}-Q${quarter}`,
    year,
    quarter,
    startsAt: new Date(Date.UTC(year, startMonthIndex, 1)),
    endsAt: new Date(Date.UTC(year, startMonthIndex + 3, 1)),
  };
}

/** The quarter `at` falls in. */
export function currentPeriod(at: Date): TransparencyPeriod {
  return buildPeriod(at.getUTCFullYear(), quarterOfMonth(at.getUTCMonth()));
}

/** The quarter before the one `at` falls in. */
export function previousPeriod(at: Date): TransparencyPeriod {
  const current = currentPeriod(at);
  return current.quarter === 1
    ? buildPeriod(current.year - 1, 4)
    : buildPeriod(current.year, current.quarter - 1);
}

/**
 * Serialise a period for the wire. `coversUntil` reaches only as far as the
 * figures actually do, so a quarter still running is published as a partial
 * count and reads as one.
 */
export function toPeriodDTO(
  period: TransparencyPeriod,
  generatedAt: Date,
): TransparencyPeriodDTO {
  const isComplete = generatedAt.getTime() >= period.endsAt.getTime();
  return {
    id: period.id,
    year: period.year,
    quarter: period.quarter,
    startsAt: period.startsAt.toISOString(),
    endsAt: period.endsAt.toISOString(),
    coversUntil: isComplete
      ? period.endsAt.toISOString()
      : generatedAt.toISOString(),
    isComplete,
  };
}
