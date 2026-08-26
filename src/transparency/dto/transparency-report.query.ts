import { IsIn, IsOptional } from 'class-validator';

/**
 * Which period `GET /transparency/report` should serve.
 *
 * Only two selectors exist, and they are relative words rather than a quarter
 * id. That keeps the public surface a fixed pair of cacheable URLs: an
 * arbitrary `?quarter=` would let a caller sweep every quarter since launch and
 * assemble a time series that this report never chose to publish, and would
 * shatter the CDN cache across an unbounded key space for no reader benefit.
 * The two periods together are what stops the page being a single frozen
 * snapshot, which is all the page needs.
 */
export const TRANSPARENCY_PERIOD_SELECTORS = ['current', 'previous'] as const;

export type TransparencyPeriodSelector =
  (typeof TRANSPARENCY_PERIOD_SELECTORS)[number];

export class TransparencyReportQuery {
  @IsOptional()
  @IsIn(TRANSPARENCY_PERIOD_SELECTORS)
  period?: TransparencyPeriodSelector;
}
