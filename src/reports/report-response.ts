import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from './entities/report.entity';
import { acknowledgementFor } from './report-severity';

// Mirrors `ReportDTO` in
// `queerpulse/src/features/safety/api/reports.api.ts` exactly.
export interface ReportDTO {
  id: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  reasonCode: string;
  severity: ReportSeverity;
  status: ReportStatus;
  createdAt: string;
  slaDueAt: string;
  acknowledgement: string;
}

export function toReportDTO(report: Report): ReportDTO {
  return {
    id: report.id,
    subjectType: report.subjectType,
    subjectId: report.subjectId,
    reasonCode: report.reasonCode,
    severity: report.severity,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    slaDueAt: report.slaDueAt.toISOString(),
    acknowledgement: acknowledgementFor(report.severity),
  };
}
