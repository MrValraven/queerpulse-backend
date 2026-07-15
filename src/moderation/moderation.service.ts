import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository, SelectQueryBuilder } from 'typeorm';
import { cursorPaginate } from '../common/cursor-pagination';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  ListModReportsQuery,
  ModReportsTab,
} from './dto/list-mod-reports.query';
import { ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ReviewAppealDto } from './dto/review-appeal.dto';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { statusForAction } from './mod-action-status';
import {
  AppealAppellant,
  AppealDTO,
  AppealOriginal,
  AuditEntryDTO,
  ModCounts,
  ModReportDetail,
  ModReportDTO,
  ModReportedDTO,
  ModReporterDTO,
  ModReportsResponse,
  toAppealDTO,
  toAuditEntryDTO,
  toModReportDTO,
} from './moderation-response';

const DEFAULT_LIMIT = 20;

// Loose enough to guard `Repository.findOne({ where: { userId: subjectId } })`
// from a Postgres "invalid input syntax for type uuid" error when a
// non-member subjectId (a slug, a content id, ...) is checked against a
// `uuid` column.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ModerationService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Appeal) private readonly appeals: Repository<Appeal>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  // GET /mod/reports — filterable, cursor-paginated queue. `tab` (not
  // `status`, which the frontend never sends — C4) is mapped to a status
  // filter server-side; the envelope is `{items, counts, page}` (C5), not the
  // shared `CursorPage` used by other list endpoints in this codebase.
  async list(query: ListModReportsQuery): Promise<ModReportsResponse> {
    const qb = this.reports.createQueryBuilder('r');
    this.applyTabFilter(qb, query.tab);

    if (query.subjectType) {
      qb.andWhere('r.subjectType = :subjectType', {
        subjectType: query.subjectType,
      });
    }
    if (query.severity) {
      qb.andWhere('r.severity = :severity', { severity: query.severity });
    }
    if (query.filter === 'emergencies') {
      qb.andWhere('r.severity = :emergencySeverity', {
        emergencySeverity: ReportSeverity.Emergency,
      });
    }
    // `filter: 'mine'` is accepted (no 400) but is a documented no-op: reports
    // carry no assignee column to filter by, and adding one is out of this
    // fix's scope. `sort: 'priority'` is likewise accepted but not distinctly
    // honored — `cursorPaginate` hardcodes `(createdAt, id)` keyset ordering
    // (see connect-FINAL-review.md C1, a separate cross-cutting bug this task
    // doesn't touch) — both fall back to the default age ordering rather than
    // rejecting the request, which is what C4 requires.

    const { rows, nextCursor } = await cursorPaginate(
      qb,
      query.cursor,
      query.limit ?? DEFAULT_LIMIT,
      'r',
    );

    const [items, counts] = await Promise.all([
      Promise.all(rows.map((r) => this.toRow(r))),
      this.computeCounts(),
    ]);

    return { items, counts, page: { cursor: nextCursor } };
  }

  // GET /mod/reports/:id — includes the `detail{...}` block the drawer
  // renders (I6).
  async getById(id: string): Promise<ModReportDTO> {
    const report = await this.findReportOrThrow(id);
    return this.toRow(report, true);
  }

  // PATCH /mod/reports/:id — one moderator action against one report. Maps
  // `action` → `status` server-side (C6); writes one audit log row. Returns
  // `ModReportDTO` without `detail` (only present on the GET-by-id drawer
  // fetch, per `moderation.api.ts`'s doc comment).
  async actOnReport(
    id: string,
    actorId: string,
    dto: ModActionDto,
  ): Promise<ModReportDTO> {
    const report = await this.findReportOrThrow(id);
    report.status = statusForAction(dto.action);
    const saved = await this.reports.save(report);

    await this.writeAuditLog(
      saved.id,
      actorId,
      dto.action,
      dto.reasonCode,
      dto.note,
      dto.duration,
    );

    return this.toRow(saved);
  }

  // POST /mod/reports/bulk — applies one action to many reports, writing an
  // audit log row per report actually found. Unknown ids are silently
  // skipped (mirrors the frontend's `{ updated: string[] }` echo, which only
  // ever lists the ids that were actually touched).
  async bulkActOnReports(
    actorId: string,
    dto: ModBulkActionDto,
  ): Promise<{ updated: string[] }> {
    const rows = await this.reports.find({ where: { id: In(dto.ids) } });
    if (!rows.length) return { updated: [] };

    const status = statusForAction(dto.action);
    for (const report of rows) {
      report.status = status;
    }
    await this.reports.save(rows);

    for (const report of rows) {
      await this.writeAuditLog(
        report.id,
        actorId,
        dto.action,
        dto.reasonCode,
        dto.note,
      );
    }

    return { updated: rows.map((r) => r.id) };
  }

  // GET /mod/reports/audit?reportId= — the immutable trail for one report,
  // oldest first. Renames `createdAt`→`at` and resolves `actorName` (I7).
  async auditTrail(reportId: string): Promise<AuditEntryDTO[]> {
    const rows = await this.auditLogs.find({
      where: { reportId },
      order: { createdAt: 'ASC' },
    });
    return Promise.all(
      rows.map(async (log) =>
        toAuditEntryDTO(log, await this.nameForUserId(log.actorId)),
      ),
    );
  }

  // GET /mod/appeals — newest first, mirrors every other list in this
  // codebase (`orderBy(..., 'DESC')`).
  async listAppeals(): Promise<AppealDTO[]> {
    const rows = await this.appeals.find({ order: { createdAt: 'DESC' } });
    return Promise.all(rows.map((a) => this.toAppealRow(a)));
  }

  // PATCH /mod/appeals/:id — uphold or overturn. Also writes an audit log
  // entry against the appeal's report, when it has one.
  async reviewAppeal(
    id: string,
    actorId: string,
    dto: ReviewAppealDto,
  ): Promise<AppealDTO> {
    const appeal = await this.appeals.findOne({ where: { id } });
    if (!appeal) {
      throw new NotFoundException('Appeal not found');
    }
    if (appeal.status !== AppealStatus.Awaiting) {
      throw new ConflictException('Appeal has already been decided');
    }

    appeal.status =
      dto.decision === 'uphold' ? AppealStatus.Upheld : AppealStatus.Overturned;
    appeal.decision = dto.note ?? dto.decision;
    const saved = await this.appeals.save(appeal);

    if (saved.reportId) {
      await this.writeAuditLog(
        saved.reportId,
        actorId,
        dto.decision === 'uphold' ? 'appeal_upheld' : 'appeal_overturned',
        undefined,
        dto.note,
      );
    }

    return this.toAppealRow(saved);
  }

  // --- internals ---

  private applyTabFilter(
    qb: SelectQueryBuilder<Report>,
    tab?: ModReportsTab,
  ): void {
    if (tab === 'open') {
      qb.andWhere('r.status IN (:...openStatuses)', {
        openStatuses: [ReportStatus.Open, ReportStatus.Escalated],
      });
    } else if (tab === 'resolved') {
      qb.andWhere('r.status = :resolvedStatus', {
        resolvedStatus: ReportStatus.Resolved,
      });
    } else if (tab === 'appeals') {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "appeals" a WHERE a.report_id = r.id AND a.status = :appealStatus)`,
        { appealStatus: AppealStatus.Awaiting },
      );
    }
    // No `tab` → no status filter at all, matching "don't require status"
    // (C4): the frontend never sends one on first load.
  }

  private async computeCounts(): Promise<ModCounts> {
    const [open, resolved, appeals] = await Promise.all([
      this.reports.count({
        where: { status: In([ReportStatus.Open, ReportStatus.Escalated]) },
      }),
      this.reports.count({ where: { status: ReportStatus.Resolved } }),
      this.appeals.count({ where: { status: AppealStatus.Awaiting } }),
    ]);
    return { open, resolved, appeals };
  }

  private async toRow(
    report: Report,
    withDetail = false,
  ): Promise<ModReportDTO> {
    const [reporter, reported] = await Promise.all([
      this.describeReporter(report),
      this.describeReported(report),
    ]);
    const detail = withDetail
      ? this.buildDetail(report, reporter, reported)
      : undefined;
    return toModReportDTO(report, reporter, reported, detail);
  }

  private async describeReporter(report: Report): Promise<ModReporterDTO> {
    if (report.anonymous) return { anonymous: true };
    const name = await this.nameForUserId(report.reporterId);
    return { anonymous: false, id: report.reporterId, name };
  }

  // `subjectId` is a slug/uuid for `member` reports (per `reports.api.ts`'s
  // doc comment); for every other subject type there is no author to resolve
  // without pulling in the posts/messaging/venues modules, which is out of
  // this fix's scope (touches only `src/reports` + `src/moderation`) — those
  // rows fall back to the raw `subjectId` as both `id` and `handle`.
  private async describeReported(report: Report): Promise<ModReportedDTO> {
    const priorReports = await this.reports.count({
      where: { subjectId: report.subjectId, id: Not(report.id) },
    });

    if (report.subjectType === ReportSubjectType.Member) {
      const where = UUID_RE.test(report.subjectId)
        ? [{ slug: report.subjectId }, { userId: report.subjectId }]
        : [{ slug: report.subjectId }];
      const profile = await this.profiles.findOne({ where });
      if (profile) {
        return { id: profile.userId, handle: profile.slug, priorReports };
      }
    }

    return { id: report.subjectId, handle: report.subjectId, priorReports };
  }

  private buildDetail(
    report: Report,
    reporter: ModReporterDTO,
    reported: ModReportedDTO,
  ): ModReportDetail {
    return {
      contentAuthor: reported.handle,
      excerpt: report.detail ?? '',
      ...(report.anonymous
        ? { redactionNote: 'Reporter identity withheld.' }
        : {}),
      // No post/message/thread lookup is available within this module's
      // scope — the drawer's thread view degrades to empty rather than 400ing
      // or fabricating content.
      thread: [],
      people: [
        {
          role: 'reporter',
          name: reporter.anonymous ? 'Anonymous' : reporter.name,
          meta: report.createdAt.toISOString(),
        },
        {
          role: 'reported',
          name: reported.handle,
          handle: reported.handle,
          meta: `${reported.priorReports} prior report(s)`,
        },
      ],
    };
  }

  private async toAppealRow(appeal: Appeal): Promise<AppealDTO> {
    const [appellant, original] = await Promise.all([
      this.describeAppellant(appeal),
      this.describeOriginalAction(appeal),
    ]);
    return toAppealDTO(appeal, appellant, original);
  }

  private async describeAppellant(appeal: Appeal): Promise<AppealAppellant> {
    if (!appeal.appellantId) return { handle: 'member' };
    const profile = await this.profiles.findOne({
      where: { userId: appeal.appellantId },
    });
    if (!profile) return { handle: 'member' };
    return {
      handle: profile.slug,
      ...(profile.pronouns ? { pronoun: profile.pronouns } : {}),
    };
  }

  private async describeOriginalAction(
    appeal: Appeal,
  ): Promise<AppealOriginal> {
    const log = appeal.actionId
      ? await this.auditLogs.findOne({ where: { id: appeal.actionId } })
      : null;
    if (!log) {
      return {
        action: 'unknown',
        by: 'Unknown',
        when: appeal.createdAt.toISOString(),
        reason: '',
      };
    }
    return {
      action: log.action,
      by: await this.nameForUserId(log.actorId),
      when: log.createdAt.toISOString(),
      reason: log.reasonCode ?? log.note ?? '',
    };
  }

  private async nameForUserId(userId: string): Promise<string> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (profile) return `${profile.firstName} ${profile.lastName}`.trim();
    const user = await this.users.findOne({ where: { id: userId } });
    return user?.email ?? 'Member';
  }

  private async findReportOrThrow(id: string): Promise<Report> {
    const report = await this.reports.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    return report;
  }

  private async writeAuditLog(
    reportId: string,
    actorId: string,
    action: string,
    reasonCode?: string,
    note?: string,
    duration?: string,
  ): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        reportId,
        actorId,
        action,
        reasonCode: reasonCode ?? null,
        note: note ?? null,
        duration: duration ?? null,
      }),
    );
  }
}
