import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  FindOptionsWhere,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { isUniqueViolation } from '../common/db-errors';
import { cursorPaginate } from '../common/cursor-pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import {
  ListModReportsQuery,
  ModReportsTab,
} from './dto/list-mod-reports.query';
import { AuditFeedQuery } from './dto/audit-feed.query';
import { CreateAppealDto } from './dto/create-appeal.dto';
import { ModActionCode, ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ReasonCode } from '../reports/reason-catalogue';
import { ReviewAppealDto } from './dto/review-appeal.dto';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModAuditService } from './mod-audit.service';
import { statusForAction } from './mod-action-status';
import {
  AppealAppellant,
  AppealDTO,
  AppealOriginal,
  AuditEntryDTO,
  AuditFeedResponseDTO,
  ModCounts,
  ModReportDetail,
  ModReportDTO,
  ModReportedDTO,
  ModReporterDTO,
  ModReportsResponse,
  SubmittedAppealDTO,
  toAppealDTO,
  toModReportDTO,
  toSubmittedAppealDTO,
} from './moderation-response';

const DEFAULT_LIMIT = 20;

// The moderator actions a member can actually appeal — the ones that land on
// an account or its content. `dismiss`/`escalate`/`shield` and the appeal
// bookkeeping actions (`appeal_upheld`, `suspension_lifted`, …) are not
// contestable outcomes, so they never become the target of a fresh appeal.
const APPEALABLE_ACTIONS = [
  'warn',
  'hide_content',
  'remove_content',
  'restrict',
  'suspend',
  'ban',
];

// Loose enough to guard `Repository.findOne({ where: { userId: subjectId } })`
// from a Postgres "invalid input syntax for type uuid" error when a
// non-member subjectId (a slug, a content id, ...) is checked against a
// `uuid` column.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Facade over the moderation queue/detail/appeals read+action paths. The two
 * cohesive clusters it once owned inline now live in dedicated services —
 * audit-log write/read + actor-name resolution in {@link ModAuditService}, and
 * account enforcement (suspend/ban/lift/restore + deactivation-sync) in
 * {@link AccountEnforcementService}. Every public method below keeps its
 * original signature and behavior; the extraction is a concern split, not an
 * API change.
 */
@Injectable()
export class ModerationService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(Appeal) private readonly appeals: Repository<Appeal>,
    @InjectRepository(ModAuditLog)
    private readonly auditLogs: Repository<ModAuditLog>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // Read-only: a `listing`-subject report's detail view surfaces the live
    // listing's pasted evidence (item #13). Registered directly on
    // `ModerationModule` (TypeORM allows the same entity in multiple modules —
    // see the module's `AccountDeactivation` precedent).
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    private readonly dataSource: DataSource,
    private readonly auth: AuthService,
    private readonly audit: ModAuditService,
    private readonly accountEnforcement: AccountEnforcementService,
    private readonly contentModeration: ContentModerationService,
    private readonly notifications: NotificationsService,
  ) {}

  // The two actions whose whole point is to change the target content's
  // visibility. `hide_content` withholds it from public/member reads;
  // `remove_content` tombstones it. Recorded in the `content_moderation` state
  // table, in the same transaction as the report status + audit row.
  private static readonly CONTENT_ACTIONS = new Set<string>([
    'hide_content',
    'remove_content',
  ]);

  // The actions that produce a member-facing outcome the sanctioned member
  // should be told about. `warn` has no account effect (so `enforceAgainstUser`
  // returns null for it) but is still an outcome the member must hear — the
  // audit named "warned" first.
  private static readonly OUTCOME_ACTIONS = new Set<string>([
    'warn',
    'suspend',
    'ban',
  ]);

  // GET /mod/reports — filterable, cursor-paginated queue. `tab` (not
  // `status`, which the frontend never sends — C4) is mapped to a status
  // filter server-side. The envelope is now the shared `CursorPage`
  // (`{ data, pageInfo: { nextCursor, hasMore } }`) every other list endpoint
  // uses, with the queue's real per-tab `counts` carried alongside it — the
  // former one-off `{ items, counts, page: { cursor } }` outlier is gone.
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

    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      query.cursor,
      query.limit ?? DEFAULT_LIMIT,
      'r',
    );

    const [items, counts] = await Promise.all([
      this.toRows(rows),
      this.computeCounts(),
    ]);

    return { data: items, pageInfo: { nextCursor, hasMore }, counts };
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

    // Report status, enforcement against the member, and the audit row commit
    // together or not at all. A resolved report whose suspension failed to
    // write is exactly the bug this method exists to fix, in a subtler form.
    const { saved, enforceResult } = await this.dataSource.transaction(
      async (manager) => {
        report.status = statusForAction(dto.action);
        const saved = await manager.save(report);

        const enforceResult = await this.accountEnforcement.enforceAgainstUser(
          manager,
          report,
          dto,
        );

        await this.audit.writeAuditLog(
          saved.id,
          actorId,
          dto.action,
          dto.reasonCode,
          dto.note,
          dto.duration,
          manager,
        );

        // The takedown itself — enrolled in this same transaction so a
        // `hide_content`/`remove_content` can never resolve the report and log
        // an audit entry while leaving the reported content live (the P3 gap).
        if (ModerationService.CONTENT_ACTIONS.has(dto.action)) {
          await this.contentModeration.applyAction(manager, {
            subjectType: report.subjectType,
            subjectId: report.subjectId,
            action: dto.action as 'hide_content' | 'remove_content',
            actorId,
            reportId: saved.id,
            reasonCode: dto.reasonCode,
            note: dto.note,
          });
        }

        return { saved, enforceResult };
      },
    );

    // Outside the transaction: revocation touches a different aggregate and
    // must not be able to roll the enforcement back if it fails. It is defence
    // in depth anyway — `JwtStrategy` re-reads status per request, so the
    // member is already locked out with or without this.
    if (enforceResult) {
      await this.auth.revokeAllForUser(enforceResult.userId);
    }

    // Tell the reporter their report has been dealt with. Skipped for an
    // anonymous report (no `reporterId` to reach) and when the acting moderator
    // is the reporter. No actor — moderation outcomes are the platform's word,
    // not a member action. Best-effort, post-commit.
    if (saved.reporterId && saved.reporterId !== actorId) {
      try {
        await this.notifications.create(
          saved.reporterId,
          NotificationType.ReportResolved,
          { source: 'report', reportId: saved.id, outcome: saved.status },
        );
      } catch {
        // Intentionally ignored — the report action already committed.
      }
    }

    // Tell the *sanctioned member* the outcome and why (warn/suspend/ban) — the
    // gap the audit named. Best-effort, post-commit, same as the reporter path.
    await this.notifyModerationOutcome(
      actorId,
      dto,
      await this.resolveOutcomeTarget(report, dto, enforceResult),
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

    const outcomes = await this.dataSource.transaction(async (manager) => {
      for (const report of rows) {
        report.status = status;
      }
      await manager.save(rows);

      // Each report paired with its enforcement result, so the post-commit
      // pass can revoke sessions AND notify the right member with the right
      // suspension expiry.
      const outcomes: Array<{
        report: Report;
        enforceResult: { userId: string; suspendedUntil: Date | null } | null;
      }> = [];
      for (const report of rows) {
        // Any unenforceable subject fails the whole batch rather than
        // partially applying. A moderator selecting twelve reports and
        // suspending needs to know all twelve landed, not eleven.
        const enforceResult = await this.accountEnforcement.enforceAgainstUser(
          manager,
          report,
          dto,
        );
        outcomes.push({ report, enforceResult });

        await this.audit.writeAuditLog(
          report.id,
          actorId,
          dto.action,
          dto.reasonCode,
          dto.note,
          dto.duration,
          manager,
        );

        if (ModerationService.CONTENT_ACTIONS.has(dto.action)) {
          await this.contentModeration.applyAction(manager, {
            subjectType: report.subjectType,
            subjectId: report.subjectId,
            action: dto.action as 'hide_content' | 'remove_content',
            actorId,
            reportId: report.id,
            reasonCode: dto.reasonCode,
            note: dto.note,
          });
        }
      }
      return outcomes;
    });

    const suspendedUserIds = outcomes
      .map((outcome) => outcome.enforceResult?.userId)
      .filter((userId): userId is string => Boolean(userId));
    for (const userId of new Set(suspendedUserIds)) {
      await this.auth.revokeAllForUser(userId);
    }

    // Notify each sanctioned member of the outcome — one row per report, so a
    // member named in several reports of the same batch hears about each. Same
    // best-effort, post-commit contract as the single-report path.
    for (const { report, enforceResult } of outcomes) {
      await this.notifyModerationOutcome(
        actorId,
        dto,
        await this.resolveOutcomeTarget(report, dto, enforceResult),
      );
    }

    return { updated: rows.map((r) => r.id) };
  }

  /**
   * The member an outcome notification should reach, plus a suspension's expiry
   * when there is one.
   *
   * `warn` does no account enforcement (so `enforceResult` is null for it) — it
   * resolves the reported member directly, and yields nothing when the subject
   * can't be tied to an account (a warn on a content report). `suspend`/`ban`
   * reuse the account the enforcement already landed on, carrying its expiry
   * (`null` = permanent ban). Any non-outcome action yields null.
   */
  private async resolveOutcomeTarget(
    report: Report,
    dto: { action: ModActionCode },
    enforceResult: { userId: string; suspendedUntil: Date | null } | null,
  ): Promise<{ userId: string; expiresAt: Date | null } | null> {
    if (!ModerationService.OUTCOME_ACTIONS.has(dto.action)) return null;
    if (dto.action === 'warn') {
      const profile =
        await this.accountEnforcement.resolveReportedProfile(report);
      return profile ? { userId: profile.userId, expiresAt: null } : null;
    }
    return enforceResult
      ? {
          userId: enforceResult.userId,
          expiresAt: enforceResult.suspendedUntil,
        }
      : null;
  }

  /**
   * Tell the sanctioned member what happened and why — the exact gap the audit
   * named ("a warned/suspended member has no idea why").
   *
   * No actor is passed, so `notifications.create` bypasses the block/mute filter
   * and the per-type preference gate (there is deliberately no toggle for
   * moderation outcomes) and always writes: a moderation outcome is the
   * platform's word, not a member action. The moderator's `note` — documented as
   * "the exact member-facing text the member reads" — rides along so the member
   * sees the reason. Best-effort and post-commit: the enforcement already
   * committed and must not roll back on a notification failure.
   */
  private async notifyModerationOutcome(
    actorId: string,
    dto: { action: ModActionCode; reasonCode: ReasonCode; note?: string },
    target: { userId: string; expiresAt: Date | null } | null,
  ): Promise<void> {
    // A moderator acting on their own report never notifies themselves.
    if (!target || target.userId === actorId) return;
    try {
      await this.notifications.create(
        target.userId,
        NotificationType.ModerationOutcome,
        {
          source: 'moderation',
          action: dto.action,
          reasonCode: dto.reasonCode,
          // Always a string (never omitted) so the client's `{note}` copy token
          // resolves to "" rather than rendering the literal placeholder — a
          // bulk action may carry no note.
          note: dto.note ?? '',
          ...(target.expiresAt
            ? { expiresAt: target.expiresAt.toISOString() }
            : {}),
        },
      );
    } catch {
      // Intentionally ignored — the moderation action already committed.
    }
  }

  // GET /mod/reports/audit?reportId= — the immutable trail for one report,
  // oldest first. Delegates to `ModAuditService`.
  auditTrail(reportId: string): Promise<AuditEntryDTO[]> {
    return this.audit.auditTrail(reportId);
  }

  // GET /mod/audit — the global, cross-report moderation audit feed for the
  // admin governance "Audit" tab. Delegates to `ModAuditService`.
  auditFeed(query: AuditFeedQuery): Promise<AuditFeedResponseDTO> {
    return this.audit.auditFeed(query);
  }

  // GET /mod/audit.csv — the same filtered audit feed rendered as a CSV
  // attachment for the governance "Audit" tab's export (P3-8). Delegates to
  // `ModAuditService`.
  auditFeedCsv(query: AuditFeedQuery): Promise<string> {
    return this.audit.auditFeedCsv(query);
  }

  // GET /mod/appeals — newest first, mirrors every other list in this
  // codebase (`orderBy(..., 'DESC')`).
  async listAppeals(): Promise<AppealDTO[]> {
    // Bounded page, matching `DEFAULT_LIMIT` used by the reports queue: an
    // unbounded `find` would fan a per-appeal name/audit lookup out across the
    // entire table. Newest first is preserved.
    const rows = await this.appeals.find({
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIMIT,
    });
    return this.toAppealRows(rows);
  }

  // POST /appeals — a member (crucially, possibly a SUSPENDED one, via
  // `AppealSubmitGuard`) contests a moderation decision taken on them. Resolves
  // the specific enforcement action being appealed (best-effort), enforces one
  // open appeal per action, and returns a narrow member-facing acknowledgement.
  async submitAppeal(
    appellantUserId: string,
    dto: CreateAppealDto,
  ): Promise<SubmittedAppealDTO> {
    const target = await this.resolveAppealTarget(
      appellantUserId,
      dto.actionId,
    );

    // One OPEN (awaiting) appeal at a time. Keyed on the resolved action when
    // there is one, else on the appellant alone (a cold appeal with no
    // resolvable action). The `findOne` fast-paths the ordinary case; the
    // partial unique indexes from `1785003500000` are what actually close the
    // check-then-insert race, and the `isUniqueViolation` catch below converts
    // the loser of that race into the same 409.
    const existing = await this.appeals.findOne({
      where: {
        appellantId: appellantUserId,
        status: AppealStatus.Awaiting,
        actionId: target?.actionId ?? IsNull(),
      },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an appeal awaiting review. A moderator will get to it.',
      );
    }

    try {
      const saved = await this.appeals.save(
        this.appeals.create({
          appellantId: appellantUserId,
          actionId: target?.actionId ?? null,
          reportId: target?.reportId ?? null,
          severity: target?.severity ?? ReportSeverity.Medium,
          community: null,
          argument: dto.reason,
          status: AppealStatus.Awaiting,
        }),
      );
      return toSubmittedAppealDTO(saved);
    } catch (error) {
      if (
        isUniqueViolation(error, 'UQ_appeals_open_appellant_action') ||
        isUniqueViolation(error, 'UQ_appeals_open_appellant_no_action')
      ) {
        throw new ConflictException(
          'You already have an appeal awaiting review. A moderator will get to it.',
        );
      }
      throw error;
    }
  }

  /**
   * Resolves which enforcement action a member's appeal is really about, so the
   * appeal lands in the moderator queue with the same context a moderator-side
   * `AppealDTO` carries (`actionId`/`reportId`/`severity`).
   *
   * Two paths:
   *  - `actionId` supplied — the member deep-linked a specific action. It is
   *    trusted only after confirming the action is tied to a report ABOUT THIS
   *    MEMBER (ownership scoping): a member may appeal a decision made against
   *    themselves, never someone else's. A mismatch is a 403, not a silent
   *    re-resolve, because the member asked to appeal a specific thing.
   *  - no `actionId` — the common suspended-member case. Falls back to the most
   *    recent appealable action against them.
   *
   * Returns `null` when nothing resolvable is found (a cold appeal): the appeal
   * still stands, unlinked, rather than being rejected on a lookup miss.
   */
  private async resolveAppealTarget(
    appellantUserId: string,
    actionId?: string,
  ): Promise<{
    actionId: string;
    reportId: string;
    severity: ReportSeverity;
  } | null> {
    // Reports about this member are addressed by their slug or their userId
    // (see `Report.subjectId`'s doc) — match both.
    const profile = await this.profiles.findOne({
      where: { userId: appellantUserId },
    });
    const memberSubjectIds = profile
      ? [appellantUserId, profile.slug]
      : [appellantUserId];

    const reportsAboutMember = await this.reports.find({
      where: {
        subjectType: ReportSubjectType.Member,
        subjectId: In(memberSubjectIds),
      },
    });
    const reportsById = new Map(
      reportsAboutMember.map((report) => [report.id, report]),
    );

    if (actionId) {
      const log = await this.auditLogs.findOne({ where: { id: actionId } });
      const report =
        log && log.reportId ? reportsById.get(log.reportId) : undefined;
      if (!log || !report) {
        throw new ForbiddenException(
          'That moderation action is not one you can appeal.',
        );
      }
      return {
        actionId: log.id,
        reportId: report.id,
        severity: report.severity,
      };
    }

    if (!reportsById.size) return null;

    const latestAction = await this.auditLogs.findOne({
      where: {
        reportId: In([...reportsById.keys()]),
        action: In(APPEALABLE_ACTIONS),
      },
      order: { createdAt: 'DESC' },
    });
    if (!latestAction || !latestAction.reportId) return null;

    const report = reportsById.get(latestAction.reportId);
    if (!report) return null;

    return {
      actionId: latestAction.id,
      reportId: report.id,
      severity: report.severity,
    };
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
    // This first check is only a fast, friendly reject for an already-decided
    // appeal — the authoritative guard is the conditional `update` inside the
    // transaction below, which is what actually makes the decision atomic.
    if (appeal.status !== AppealStatus.Awaiting) {
      throw new ConflictException('Appeal has already been decided');
    }

    const decidedStatus =
      dto.decision === 'uphold' ? AppealStatus.Upheld : AppealStatus.Overturned;
    const decision = dto.note ?? dto.decision;

    const saved = await this.dataSource.transaction(async (manager) => {
      // Re-check the status *inside* the transaction and flip it in one
      // conditional write: only a row still `Awaiting` is updated. Two
      // moderators deciding the same appeal concurrently race here, and exactly
      // one wins — the loser's `affected` is 0, so it throws before writing a
      // second (possibly contradictory) audit entry or running a restore
      // against an already-upheld decision.
      const updateResult = await manager.update(
        Appeal,
        { id, status: AppealStatus.Awaiting },
        { status: decidedStatus, decision },
      );
      if (updateResult.affected !== 1) {
        throw new ConflictException('Appeal has already been decided');
      }

      // An overturned appeal that leaves the member suspended is the same
      // class of bug as a suspension that never applied: a moderation decision
      // that does not take effect. Restore them as part of the same decision.
      if (dto.decision === 'overturn') {
        await this.accountEnforcement.restoreSuspensionForAppeal(
          manager,
          appeal.reportId,
        );
      }

      if (appeal.reportId) {
        await this.audit.writeAuditLog(
          appeal.reportId,
          actorId,
          dto.decision === 'uphold' ? 'appeal_upheld' : 'appeal_overturned',
          undefined,
          dto.note,
          undefined,
          manager,
        );
      }

      // Reflect the committed decision on the in-memory entity for the
      // response, matching what the conditional `update` just persisted.
      appeal.status = decidedStatus;
      appeal.decision = decision;
      return appeal;
    });

    // Tell the appellant the outcome. Skipped when the appeal has no
    // account-backed appellant, or when the reviewer is the appellant. No
    // actor — this is the platform's decision. Best-effort, post-commit. The FE
    // deep-links to the appeal-outcome page from the `appeal` source.
    if (saved.appellantId && saved.appellantId !== actorId) {
      try {
        await this.notifications.create(
          saved.appellantId,
          NotificationType.AppealResolved,
          { source: 'appeal', appealId: saved.id, outcome: saved.status },
        );
      } catch {
        // Intentionally ignored — the appeal decision already committed.
      }
    }

    return this.toAppealRow(saved);
  }

  // PATCH /mod/users/:userId/suspension — lift a suspension or ban. Delegates
  // to `AccountEnforcementService`.
  liftSuspension(
    userId: string,
    actorId: string,
    dto: LiftSuspensionDto,
  ): Promise<{ userId: string; status: UserStatus }> {
    return this.accountEnforcement.liftSuspension(userId, actorId, dto);
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
      ? await this.buildDetail(report, reporter, reported)
      : undefined;
    return toModReportDTO(report, reporter, reported, detail);
  }

  /**
   * Batched equivalent of `toRow` for a whole page — same output, in the same
   * order, but a bounded number of queries instead of ~3-4 per report.
   *
   * All reporter names resolve in one `In([...])` lookup, all reported members
   * in one more, and every subject's prior-report count in a single
   * `GROUP BY subjectId` — so a page costs three queries regardless of size,
   * where `rows.map(toRow)` cost three or four per row. `list()` never asks for
   * the `detail` block (only `GET /mod/reports/:id` does, via single `toRow`),
   * so none is built here.
   */
  private async toRows(reports: Report[]): Promise<ModReportDTO[]> {
    if (!reports.length) return [];

    // Only real reporters need a name — anonymous and erased reporters stay
    // hidden and never enter the lookup (anonymization is unchanged).
    const reporterUserIds = reports
      .filter((report) => !report.anonymous && report.reporterId)
      .map((report) => report.reporterId as string);

    const [reporterNames, reportedProfiles, priorReportCounts] =
      await Promise.all([
        this.audit.namesForUserIds(reporterUserIds),
        this.resolveReportedProfiles(reports),
        this.priorReportCountsBySubject(reports),
      ]);

    return reports.map((report) => {
      const reporter = this.buildReporter(report, reporterNames);
      const reported = this.buildReported(
        report,
        reportedProfiles,
        priorReportCounts,
      );
      return toModReportDTO(report, reporter, reported);
    });
  }

  // Sync twin of `describeReporter` fed from a pre-resolved name map — the
  // anonymization arms are identical: anonymous and erased reporters stay
  // `{ anonymous: true }` and are never named.
  private buildReporter(
    report: Report,
    reporterNames: Map<string, string>,
  ): ModReporterDTO {
    if (report.anonymous) return { anonymous: true };
    if (!report.reporterId) return { anonymous: true };
    return {
      anonymous: false,
      id: report.reporterId,
      name: reporterNames.get(report.reporterId) ?? 'Member',
    };
  }

  // Sync twin of `describeReported` fed from pre-resolved profile and count
  // maps. `priorReports` is the total reports for the subject minus this one,
  // exactly as `count({ subjectId, id: Not(report.id) })` computed it per-row.
  private buildReported(
    report: Report,
    reportedProfiles: Map<string, Profile>,
    priorReportCounts: Map<string, number>,
  ): ModReportedDTO {
    const priorReports = (priorReportCounts.get(report.subjectId) ?? 1) - 1;
    const profile = reportedProfiles.get(report.subjectId);
    if (profile) {
      return { id: profile.userId, handle: profile.slug, priorReports };
    }
    return { id: report.subjectId, handle: report.subjectId, priorReports };
  }

  /**
   * Batched `resolveReportedProfile` over a page — keyed by `subjectId`.
   *
   * Member subjects are addressed by slug or (for uuid-looking ids) by userId,
   * exactly as the single resolver's `[{ slug }, { userId }]` where-array. One
   * `find` covers the whole page; non-member subjects have no entry and fall
   * back to the raw `subjectId` in `buildReported`, matching the single path.
   */
  private async resolveReportedProfiles(
    reports: Report[],
  ): Promise<Map<string, Profile>> {
    const bySubjectId = new Map<string, Profile>();

    const memberReports = reports.filter(
      (report) => report.subjectType === ReportSubjectType.Member,
    );
    if (!memberReports.length) return bySubjectId;

    const subjectSlugs = [
      ...new Set(memberReports.map((report) => report.subjectId)),
    ];
    const subjectUserIds = [
      ...new Set(
        memberReports
          .map((report) => report.subjectId)
          .filter((subjectId) => UUID_RE.test(subjectId)),
      ),
    ];

    const where: FindOptionsWhere<Profile>[] = [{ slug: In(subjectSlugs) }];
    if (subjectUserIds.length) where.push({ userId: In(subjectUserIds) });
    const profiles = await this.profiles.find({ where });

    const profilesBySlug = new Map<string, Profile>();
    const profilesByUserId = new Map<string, Profile>();
    for (const profile of profiles) {
      profilesBySlug.set(profile.slug, profile);
      profilesByUserId.set(profile.userId, profile);
    }

    for (const report of memberReports) {
      const match =
        profilesBySlug.get(report.subjectId) ??
        (UUID_RE.test(report.subjectId)
          ? profilesByUserId.get(report.subjectId)
          : undefined);
      if (match) bySubjectId.set(report.subjectId, match);
    }
    return bySubjectId;
  }

  /**
   * Total reports per `subjectId` across the page, in a single `GROUP BY`.
   *
   * `buildReported` subtracts one (the report itself) to reproduce the per-row
   * `count({ subjectId, id: Not(report.id) })`.
   */
  private async priorReportCountsBySubject(
    reports: Report[],
  ): Promise<Map<string, number>> {
    const totalsBySubject = new Map<string, number>();

    const subjectIds = [...new Set(reports.map((report) => report.subjectId))];
    if (!subjectIds.length) return totalsBySubject;

    const rows = await this.reports
      .createQueryBuilder('r')
      .select('r.subjectId', 'subjectId')
      .addSelect('COUNT(*)', 'total')
      .where('r.subjectId IN (:...subjectIds)', { subjectIds })
      .groupBy('r.subjectId')
      .getRawMany<{ subjectId: string; total: string }>();

    for (const row of rows) {
      totalsBySubject.set(row.subjectId, Number(row.total));
    }
    return totalsBySubject;
  }

  private async describeReporter(report: Report): Promise<ModReporterDTO> {
    if (report.anonymous) return { anonymous: true };
    // An erased reporter (`reporter_id` NULLed by the erasure sweep) becomes
    // indistinguishable from an anonymous one — which is exactly right: the
    // report stands, the person behind it is no longer identifiable. Reusing
    // the existing `{ anonymous: true }` arm keeps `ModReporterDTO.id`
    // honestly non-nullable instead of inventing a placeholder id.
    if (!report.reporterId) return { anonymous: true };
    const name = await this.audit.nameForUserId(report.reporterId);
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

    // Shared with the enforcement path so the person shown in the drawer and
    // the person a `suspend` actually lands on can never diverge.
    const profile =
      await this.accountEnforcement.resolveReportedProfile(report);
    if (profile) {
      return { id: profile.userId, handle: profile.slug, priorReports };
    }

    return { id: report.subjectId, handle: report.subjectId, priorReports };
  }

  private async buildDetail(
    report: Report,
    reporter: ModReporterDTO,
    reported: ModReportedDTO,
  ): Promise<ModReportDetail> {
    // Listing-report enrichment (item #13): a `listing`-subject report is keyed
    // by the listing's slug, so pull the live listing to surface its pasted
    // ownership/claim evidence, and expose a `listing_dispute`'s free-text
    // reason as its own field (over and above the shared `excerpt`).
    const listingEnrichment = await this.buildListingEnrichment(report);

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
      ...listingEnrichment,
    };
  }

  /** The `disputeReason` + `listingEvidence` + `contactEmail` fields for a
   * `listing`-subject report (item #13), or an empty object for every other
   * subject type. The evidence is read from the live listing row (keyed by the
   * report's `subjectId` slug); it degrades to omitted if the listing no longer
   * exists. `contactEmail` is the off-account contact the disputer left
   * (`DisputeListingDto.contactEmail`), persisted on the report row and surfaced
   * moderator-only so a reviewer can reach a disputer with no account. */
  private async buildListingEnrichment(
    report: Report,
  ): Promise<
    Pick<ModReportDetail, 'disputeReason' | 'listingEvidence' | 'contactEmail'>
  > {
    if (report.subjectType !== ReportSubjectType.Listing) return {};

    const listing = await this.listings.findOne({
      where: { slug: report.subjectId },
      select: { evidence: true },
    });

    const disputeReason =
      report.reasonCode === 'listing_dispute' && report.detail
        ? report.detail
        : undefined;
    const listingEvidence = listing?.evidence ? listing.evidence : undefined;
    // Read straight off the report row — `findReportOrThrow` loads the full
    // entity (no column `select`), so `contactEmail` is already present.
    const contactEmail = report.contactEmail ? report.contactEmail : undefined;

    return {
      ...(disputeReason ? { disputeReason } : {}),
      ...(listingEvidence ? { listingEvidence } : {}),
      ...(contactEmail ? { contactEmail } : {}),
    };
  }

  private async toAppealRow(appeal: Appeal): Promise<AppealDTO> {
    const [appellant, original] = await Promise.all([
      this.describeAppellant(appeal),
      this.describeOriginalAction(appeal),
    ]);
    return toAppealDTO(appeal, appellant, original);
  }

  /**
   * Batched equivalent of `toAppealRow` for a whole page — same output, same
   * order, in a bounded number of queries instead of ~3 per appeal.
   *
   * Appellant profiles resolve in one `In([...])` lookup, the appealed audit
   * rows in one more, and every one of those rows' actor names in a single
   * `namesForUserIds` — so a page is three queries regardless of size.
   */
  private async toAppealRows(appeals: Appeal[]): Promise<AppealDTO[]> {
    if (!appeals.length) return [];

    const appellantUserIds = appeals
      .filter((appeal) => appeal.appellantId)
      .map((appeal) => appeal.appellantId as string);
    const actionIds = appeals
      .filter((appeal) => appeal.actionId)
      .map((appeal) => appeal.actionId as string);

    const [appellantProfiles, actionLogs] = await Promise.all([
      this.profilesByUserIds(appellantUserIds),
      this.auditLogsByIds(actionIds),
    ]);

    const actorIds = [...actionLogs.values()]
      .map((log) => log.actorId)
      .filter((actorId): actorId is string => actorId !== null);
    const actorNames = await this.audit.namesForUserIds(actorIds);

    return appeals.map((appeal) => {
      const appellant = this.buildAppellant(appeal, appellantProfiles);
      const original = this.buildOriginalAction(appeal, actionLogs, actorNames);
      return toAppealDTO(appeal, appellant, original);
    });
  }

  // Sync twin of `describeAppellant` fed from a pre-resolved profile map.
  private buildAppellant(
    appeal: Appeal,
    appellantProfiles: Map<string, Profile>,
  ): AppealAppellant {
    if (!appeal.appellantId) return { handle: 'member' };
    const profile = appellantProfiles.get(appeal.appellantId);
    if (!profile) return { handle: 'member' };
    return {
      handle: profile.slug,
      ...(profile.pronouns ? { pronoun: profile.pronouns } : {}),
    };
  }

  // Sync twin of `describeOriginalAction` fed from pre-resolved audit-log and
  // name maps — an erased actor (`actorId === null`) still names as
  // 'Deleted member' via `resolveActorName`.
  private buildOriginalAction(
    appeal: Appeal,
    actionLogs: Map<string, ModAuditLog>,
    actorNames: Map<string, string>,
  ): AppealOriginal {
    const log = appeal.actionId ? actionLogs.get(appeal.actionId) : undefined;
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
      by: this.audit.resolveActorName(log.actorId, actorNames),
      when: log.createdAt.toISOString(),
      reason: log.reasonCode ?? log.note ?? '',
    };
  }

  // Batched sibling of the appellant lookup in `describeAppellant`: userId ->
  // full `Profile` (kept over `MemberLookup` because the appellant DTO needs
  // `pronouns`, which `MemberRef` does not carry).
  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    const byUserId = new Map<string, Profile>();
    const uniqueUserIds = [...new Set(userIds)];
    if (!uniqueUserIds.length) return byUserId;

    const profiles = await this.profiles.find({
      where: { userId: In(uniqueUserIds) },
    });
    for (const profile of profiles) byUserId.set(profile.userId, profile);
    return byUserId;
  }

  // Batched sibling of the audit-log lookup in `describeOriginalAction`:
  // id -> `ModAuditLog`, in one `In([...])`.
  private async auditLogsByIds(
    ids: string[],
  ): Promise<Map<string, ModAuditLog>> {
    const byId = new Map<string, ModAuditLog>();
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return byId;

    const logs = await this.auditLogs.find({ where: { id: In(uniqueIds) } });
    for (const log of logs) byId.set(log.id, log);
    return byId;
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
      by: await this.audit.nameForUserId(log.actorId),
      when: log.createdAt.toISOString(),
      reason: log.reasonCode ?? log.note ?? '',
    };
  }

  private async findReportOrThrow(id: string): Promise<Report> {
    const report = await this.reports.findOne({ where: { id } });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    return report;
  }
}
