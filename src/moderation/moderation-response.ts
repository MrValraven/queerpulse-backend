import {
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
  Report,
} from '../reports/entities/report.entity';
import { CursorPage } from '../common/cursor-pagination';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';

// Everything here mirrors
// `queerpulse/src/features/admin/api/moderation.api.ts` exactly. These are
// pure shape builders — the repository lookups that resolve `reporter`/
// `reported`/`appellant`/`original` live in `moderation.service.ts` so this
// file stays a plain, easily-unit-tested mapping layer.

// ADM-22: a reporter credibility signal, mirroring `ModReportedDTO`'s
// prior-history pattern but on the FILER's side rather than the subject's.
// `priorReports`/`priorDismissed` are only ever counted over the reporter's
// PAST RESOLVED reports (an open report has no verdict yet, so it carries no
// signal either way) and are deliberately raw counts, not a derived score or
// tier — an honest "N filed, M dismissed" a moderator can weigh themselves,
// not a fabricated/opaque metric. Absent entirely on an anonymous or
// already-erased reporter (there is no identity to attach a track record to).
export type ModReporterDTO =
  | { anonymous: true }
  | {
      anonymous: false;
      id: string;
      name: string;
      priorReports: number;
      priorDismissed: number;
    };

export interface ModReportedDTO {
  id: string;
  handle: string;
  priorReports: number;
}

/** Which parties a resolved report's outcome was communicated to — mirrors
 *  the frontend's `ResolutionNotifiedParty` exactly. */
export type ResolutionNotifiedParty = 'member' | 'reporter' | 'affected';

// Mirrors `ModReportDTO['resolution']` (`moderation.api.ts`) — the
// denormalized outcome a resolved report's row now carries (COM-7).
export interface ModReportResolutionDTO {
  action: string;
  outcomeLabel: string;
  actorName: string;
  closedAt: string;
  note: string;
  notified: ResolutionNotifiedParty[];
}

const DURATION_UNIT: Record<string, string> = { h: 'hour', d: 'day' };

// "7d" -> "7 days", "24h" -> "24 hours". Falls back to the raw string for
// anything that doesn't match the `parseDuration` shape (defensive only —
// every duration reaching here already passed that validator).
function humanDuration(duration: string): string {
  const match = /^(\d+)([hd])$/.exec(duration);
  if (!match) return duration;
  const amount = match[1];
  const unitKey = match[2];
  if (!amount || !unitKey) return duration;
  const unit = DURATION_UNIT[unitKey] ?? unitKey;
  return `${amount} ${unit}${amount === '1' ? '' : 's'}`;
}

// The member-facing outcome badge text for a resolved report — server-owned
// so the frontend never has to reconstruct it from the raw action code.
const OUTCOME_LABEL: Record<string, string> = {
  dismiss: 'Dismissed',
  warn: 'Warned',
  hide_content: 'Hid content',
  remove_content: 'Removed content',
  restrict: 'Restricted',
  suspend: 'Suspended',
  ban: 'Banned',
  shield: 'Shielded member',
};

export function outcomeLabelFor(
  action: string,
  duration: string | null,
): string {
  const base = OUTCOME_LABEL[action] ?? action;
  return duration ? `${base} · ${humanDuration(duration)}` : base;
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
  // Listing-report enrichment (item #13), only present on a `listing`-subject
  // report's detail. `disputeReason` is the free-text a disputer/claimer typed
  // (`POST /listings/:ref/dispute`); `listingEvidence` is the ownership/claim
  // proof the submitter pasted into the listing itself — surfaced here so a
  // reviewer can weigh a claim without leaving the queue.
  disputeReason?: string;
  listingEvidence?: string;
  // Off-account contact the disputer left when they filed
  // (`DisputeListingDto.contactEmail`, stored on the report row). MODERATOR-ONLY
  // — surfaced here so a reviewer can reach a disputer who has no account;
  // deliberately absent from every member-facing/report-list DTO. Present only
  // when the report actually carries one.
  contactEmail?: string;
  // The report's raw `evidence` jsonb array (P0.9) — client-supplied entries
  // plus any server-authoritative snapshot (`message-snapshot`,
  // `housing-snapshot`). MODERATOR-ONLY: surfaced on the drawer so a reviewer
  // sees the reported listing/message exactly as it was at filing time, even
  // after a later edit or takedown. Present only when the report carries any.
  evidence?: unknown[];
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
  /** Null when unassigned (COM-5). */
  assignedModeratorId?: string | null;
  /** Only present when `assignedModeratorId` is set. "Deleted member" after
   *  the assigning moderator's erasure. */
  assignedModeratorName?: string;
  /** Only present on a resolved report, once `moderation.service.ts` has
   *  written the resolution block (COM-7). */
  resolution?: ModReportResolutionDTO;
  /** Only present on `GET /mod/reports/:id`. */
  detail?: ModReportDetail;
}

export interface ModCounts {
  open: number;
  appeals: number;
  resolved: number;
}

// The moderation queue now answers with the repo's canonical cursor-page
// envelope — `CursorPage<T>` = `{ data, pageInfo: { nextCursor, hasMore } }`,
// the same shape the feed/forum/blocks/mutes/saved lists use — instead of its
// former one-off `{ items, counts, page: { cursor } }`. `counts` (the real
// per-tab totals the queue header renders) is orthogonal domain data with no
// home in the pagination envelope, so it is carried alongside rather than
// dropped. Mirrors `ModReportsResponse` in `moderation.api.ts`.
export interface ModReportsResponse extends CursorPage<ModReportDTO> {
  counts: ModCounts;
}

export function toModReportDTO(
  report: Report,
  reporter: ModReporterDTO,
  reported: ModReportedDTO,
  detail?: ModReportDetail,
  assignedModeratorName?: string,
  resolution?: ModReportResolutionDTO,
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
    assignedModeratorId: report.assignedModeratorId,
    ...(assignedModeratorName ? { assignedModeratorName } : {}),
    ...(resolution ? { resolution } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Builds the `resolution` DTO block for a resolved report, or `undefined`
 *  when it hasn't been resolved yet (`resolvedAt` unset). `actorName` is
 *  pre-resolved by the caller (batched via `ModAuditService.namesForUserIds`
 *  for a page, or a single `nameForUserId` for one report) so this stays a
 *  pure shape builder. */
export function toResolutionDTO(
  report: Report,
  actorName: string,
): ModReportResolutionDTO | undefined {
  if (!report.resolvedAt || !report.resolutionAction) return undefined;
  return {
    action: report.resolutionAction,
    outcomeLabel: outcomeLabelFor(
      report.resolutionAction,
      report.resolutionDuration,
    ),
    actorName,
    closedAt: report.resolvedAt.toISOString(),
    note: report.resolutionNote ?? '',
    notified: (report.resolutionNotified ?? []) as ResolutionNotifiedParty[],
  };
}

// Mirrors `AuditEntryDTO` (`moderation.api.ts:93-102`) — renamed
// `createdAt`→`at`, added `actorName` (I7).
export interface AuditEntryDTO {
  id: string;
  /**
   * `null` for a moderator action not tied to a specific report — today only
   * `suspension_lifted` (see `ModAuditLog.reportId`). Such an entry is never
   * actually returned by `GET /mod/reports/audit`, which filters by report;
   * the field is widened because the DTO mirrors the entity, and narrowing it
   * here would be a lie that only holds while no global audit feed exists.
   */
  reportId: string | null;
  /**
   * `null` once the acting moderator has erased their account — the log entry
   * survives them (see `ModAuditLog.actorId`). `actorName` is then
   * 'Deleted member'. NOTE: the frontend's `moderation.api.ts` still types this
   * `string`; it needs widening to `string | null` to match.
   */
  actorId: string | null;
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

// `GET /mod/audit` — the global, cross-report moderation audit feed. One row
// per `mod_audit_logs` entry, newest first, independent of `AuditEntryDTO`
// (which is scoped to a single report's trail).
export interface AuditFeedRowDTO {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  reasonCode?: string;
  note?: string;
  /** Human-readable subject line — a linked report's subject, or 'Platform action'. */
  subject: string;
  reportId: string | null;
  at: string;
}

export interface AuditFeedModerator {
  id: string;
  name: string;
}

// The canonical offset envelope (`{items,total,page,pageSize}`, see
// `common/pagination.ts`) plus the audit-feed-specific `moderators` options.
// `page`/`pageSize` echo back the request so the client's page-count maths and
// server truth can never drift; earlier this shape omitted them, making it a
// pagination-envelope outlier.
export interface AuditFeedResponseDTO {
  items: AuditFeedRowDTO[];
  total: number;
  page: number;
  pageSize: number;
  /** Distinct actors across the whole table, for the moderator filter's options. */
  moderators: AuditFeedModerator[];
}

export function toAuditFeedRow(
  log: ModAuditLog,
  actorName: string,
  subject: string,
): AuditFeedRowDTO {
  return {
    id: log.id,
    actorId: log.actorId,
    actorName,
    action: log.action,
    ...(log.reasonCode ? { reasonCode: log.reasonCode } : {}),
    ...(log.note ? { note: log.note } : {}),
    subject,
    reportId: log.reportId,
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

// `POST /appeals` response — the member-facing acknowledgement. Deliberately
// NARROWER than `AppealDTO` (the moderator queue view): the member who just
// filed gets back only their own appeal's id, its status, and when it was
// filed. It leaks none of the enriched moderation context — the resolved
// `actionId`/`reportId`, the appellant handle, the original moderator's name —
// which belongs to the review side, not the person under review.
export interface SubmittedAppealDTO {
  id: string;
  status: AppealStatus;
  createdAt: string;
}

export function toSubmittedAppealDTO(appeal: Appeal): SubmittedAppealDTO {
  return {
    id: appeal.id,
    status: appeal.status,
    createdAt: appeal.createdAt.toISOString(),
  };
}

// `GET /appeals/me` response — the calling member's OWN appeal record.
// Deliberately narrower than `AppealDTO` (the moderator queue's enriched
// view): a member checking on their own appeal has no business seeing an
// `appellant` block (it's already them) or the original moderator's name —
// only their own case's status, the moderator's decision text (once
// resolved), and the facts they themselves supplied. Mirrors
// `queerpulse/src/features/safety/api/appeals.api.ts`'s `MemberAppealDTO`.
export interface MemberAppealDTO {
  id: string;
  status: AppealStatus;
  decision: string | null;
  argument: string;
  severity: ReportSeverity;
  community: string | null;
  createdAt: string;
}

export function toMemberAppealDTO(appeal: Appeal): MemberAppealDTO {
  return {
    id: appeal.id,
    status: appeal.status,
    decision: appeal.decision,
    argument: appeal.argument,
    severity: appeal.severity,
    community: appeal.community,
    createdAt: appeal.createdAt.toISOString(),
  };
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
