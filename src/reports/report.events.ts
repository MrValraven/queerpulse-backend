import { ReportSeverity, ReportSubjectType } from './entities/report.entity';

export const REPORT_CREATED = 'report.created';

/**
 * A new report was filed (emitted only for a genuinely new row — the idempotent
 * dedupe fast-path that returns an existing open report does NOT emit). Carries
 * the derived `severity` and the polymorphic `(subjectType, subjectId)` so a
 * listener can decide whether the subject belongs to a community and whether to
 * act (e.g. community auto-freeze). Listeners must be best-effort: reacting to
 * this event must never fail the report filing that produced it.
 */
export interface ReportCreatedEvent {
  reportId: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  severity: ReportSeverity;
  reasonCode: string;
}
