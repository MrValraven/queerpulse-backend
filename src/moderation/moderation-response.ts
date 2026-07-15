import {
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
  Report,
} from '../reports/entities/report.entity';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';

// Everything here mirrors
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly. These are
// pure shape builders — the repository lookups that resolve `reporter`/
// `reported`/`appellant`/`original` live in `moderation.service.ts` so this
// file stays a plain, easily-unit-tested mapping layer.

export type ModReporterDTO =
  { anonymous: true } | { anonymous: false; id: string; name: string };

export interface ModReportedDTO {
  id: string;
  handle: string;
  priorReports: number;
}

export interface ModReportDetail {
  contentAuthor: string;
  excerpt: string;
  redactionNote?: string;
  thread: {
    author: string;
    initials: string;
    time: string;
    body: string;
    flagged?: boolean;
  }[];
  people: { role: string; name: string; handle?: string; meta: string }[];
}

// Mirrors `ModReportDTO` (`moderation.api.ts:24-40`).
export interface ModReportDTO {
  id: string;
  severity: ReportSeverity;
  reasonCode: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  reporter: ModReporterDTO;
  reported: ModReportedDTO;
  community: string | null;
  createdAt: string;
  slaDueAt: string;
  status: ReportStatus;
  /** Only present on `GET /mod/reports/:id`. */
  detail?: ModReportDetail;
}

export interface ModCounts {
  open: number;
  appeals: number;
  resolved: number;
}

// Mirrors `ModReportsResponse` (`moderation.api.ts:61-65`).
export interface ModReportsResponse {
  items: ModReportDTO[];
  counts: ModCounts;
  page: { cursor: string | null };
}

export function toModReportDTO(
  report: Report,
  reporter: ModReporterDTO,
  reported: ModReportedDTO,
  detail?: ModReportDetail,
): ModReportDTO {
  return {
    id: report.id,
    severity: report.severity,
    reasonCode: report.reasonCode,
    subjectType: report.subjectType,
    subjectId: report.subjectId,
    reporter,
    reported,
    // Best-effort: only `community`-subject reports have a directly known
    // community (the subjectId itself); reports against a member/post/reply/
    // venue/message inside a community aren't traceable to one here without
    // pulling in the communities module, which is out of this fix's scope
    // (touches only `src/reports` + `src/moderation`).
    community:
      report.subjectType === ReportSubjectType.Community
        ? report.subjectId
        : null,
    createdAt: report.createdAt.toISOString(),
    slaDueAt: report.slaDueAt.toISOString(),
    status: report.status,
    ...(detail ? { detail } : {}),
  };
}

// Mirrors `AuditEntryDTO` (`moderation.api.ts:93-102`) — renamed
// `createdAt`→`at`, added `actorName` (I7).
export interface AuditEntryDTO {
  id: string;
  reportId: string;
  actorId: string;
  actorName: string;
  action: string;
  reasonCode?: string;
  note?: string;
  at: string;
}

export function toAuditEntryDTO(
  log: ModAuditLog,
  actorName: string,
): AuditEntryDTO {
  return {
    id: log.id,
    reportId: log.reportId,
    actorId: log.actorId,
    actorName,
    action: log.action,
    ...(log.reasonCode ? { reasonCode: log.reasonCode } : {}),
    ...(log.note ? { note: log.note } : {}),
    at: log.createdAt.toISOString(),
  };
}

export interface AppealOriginal {
  action: string;
  by: string;
  when: string;
  reason: string;
}

export interface AppealAppellant {
  handle: string;
  pronoun?: string;
}

// Mirrors `AppealDTO` (`moderation.api.ts:104-115`) — `body`→`argument`,
// `open`→`awaiting`, plus `actionId`/`severity`/`appellant`/`community`/
// `original` (I8).
export interface AppealDTO {
  id: string;
  reportId: string;
  actionId: string;
  severity: ReportSeverity;
  appellant: AppealAppellant;
  community: string | null;
  argument: string;
  original: AppealOriginal;
  createdAt: string;
  status: AppealStatus;
}

export function toAppealDTO(
  appeal: Appeal,
  appellant: AppealAppellant,
  original: AppealOriginal,
): AppealDTO {
  return {
    id: appeal.id,
    // `reportId`/`actionId` are non-nullable in the frontend contract; the
    // entity keeps them nullable (no `POST /appeals` creation flow exists yet
    // to always populate them — see `entities/appeal.entity.ts`), so an
    // absent link degrades to `''` rather than `null`.
    reportId: appeal.reportId ?? '',
    actionId: appeal.actionId ?? '',
    severity: appeal.severity,
    appellant,
    community: appeal.community,
    argument: appeal.argument,
    original,
    createdAt: appeal.createdAt.toISOString(),
    status: appeal.status,
  };
}
