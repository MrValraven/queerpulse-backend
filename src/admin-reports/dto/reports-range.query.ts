import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import {
  REPORT_WEEK_RANGES,
  type ReportWeekRange,
} from '../admin-reports-response';

// `GET /admin/reports/growth` / `.../reports-by-type` (+ their `.csv`
// siblings) query — the adjustable date-range preset (ADM-17). Validated
// against the fixed `REPORT_WEEK_RANGES` allowlist rather than an arbitrary
// bounded integer, so a caller can never force an unbounded or oddball scan
// window straight through to the database.
export class ReportsRangeQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn(REPORT_WEEK_RANGES)
  weeks?: ReportWeekRange;
}
