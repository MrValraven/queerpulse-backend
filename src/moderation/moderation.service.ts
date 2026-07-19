import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { AuthService } from '../auth/auth.service';
import { cursorPaginate } from '../common/cursor-pagination';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import { parseDuration } from './parse-duration';
import {
  ListModReportsQuery,
  ModReportsTab,
} from './dto/list-mod-reports.query';
import { ModActionCode, ModActionDto } from './dto/mod-action.dto';
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
    private readonly dataSource: DataSource,
    private readonly auth: AuthService,
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

    // Report status, enforcement against the member, and the audit row commit
    // together or not at all. A resolved report whose suspension failed to
    // write is exactly the bug this method exists to fix, in a subtler form.
    const { saved, suspendedUserId } = await this.dataSource.transaction(
      async (manager) => {
        report.status = statusForAction(dto.action);
        const saved = await manager.save(report);

        const suspendedUserId = await this.enforceAgainstUser(
          manager,
          report,
          dto,
        );

        await this.writeAuditLog(
          saved.id,
          actorId,
          dto.action,
          dto.reasonCode,
          dto.note,
          dto.duration,
          manager,
        );

        return { saved, suspendedUserId };
      },
    );

    // Outside the transaction: revocation touches a different aggregate and
    // must not be able to roll the enforcement back if it fails. It is defence
    // in depth anyway — `JwtStrategy` re-reads status per request, so the
    // member is already locked out with or without this.
    if (suspendedUserId) {
      await this.auth.revokeAllForUser(suspendedUserId);
    }

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

    const suspendedUserIds = await this.dataSource.transaction(
      async (manager) => {
        for (const report of rows) {
          report.status = status;
        }
        await manager.save(rows);

        const suspended: string[] = [];
        for (const report of rows) {
          // Any unenforceable subject fails the whole batch rather than
          // partially applying. A moderator selecting twelve reports and
          // suspending needs to know all twelve landed, not eleven.
          const userId = await this.enforceAgainstUser(manager, report, dto);
          if (userId) suspended.push(userId);

          await this.writeAuditLog(
            report.id,
            actorId,
            dto.action,
            dto.reasonCode,
            dto.note,
            dto.duration,
            manager,
          );
        }
        return suspended;
      },
    );

    for (const userId of new Set(suspendedUserIds)) {
      await this.auth.revokeAllForUser(userId);
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

    const saved = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(appeal);

      // An overturned appeal that leaves the member suspended is the same
      // class of bug as a suspension that never applied: a moderation decision
      // that does not take effect. Restore them as part of the same decision.
      if (dto.decision === 'overturn') {
        await this.restoreSuspensionForAppeal(manager, saved.reportId);
      }

      if (saved.reportId) {
        await this.writeAuditLog(
          saved.reportId,
          actorId,
          dto.decision === 'uphold' ? 'appeal_upheld' : 'appeal_overturned',
          undefined,
          dto.note,
          undefined,
          manager,
        );
      }

      return saved;
    });

    return this.toAppealRow(saved);
  }

  /**
   * Restores the member behind an overturned appeal's report, if there is one
   * and they are actually suspended.
   *
   * Silent when the appeal has no `reportId`, the report is not about a member,
   * or the member is not suspended — an overturn must still record its decision
   * in all of those cases rather than 400 on a bookkeeping detail.
   */
  private async restoreSuspensionForAppeal(
    manager: EntityManager,
    reportId: string | null,
  ): Promise<void> {
    if (!reportId) return;

    const report = await manager.findOne(Report, { where: { id: reportId } });
    if (!report) return;

    const profile = await this.resolveReportedProfile(report);
    if (!profile) return;

    const user = await manager.findOne(User, {
      where: { id: profile.userId },
    });
    if (!user || user.status !== UserStatus.Suspended) return;

    await this.restoreUser(manager, user.id);
  }

  // PATCH /mod/users/:userId/suspension — lift a suspension or ban.
  //
  // Without this, `ban` (permanent, `suspendedUntil = null`) would be
  // irreversible through the API: expiry never fires for it, and the only other
  // route back — an appeal overturn — is unreachable because nothing creates
  // appeals (`POST /appeals` does not exist; see `appeal.entity.ts`).
  async liftSuspension(
    userId: string,
    actorId: string,
    dto: LiftSuspensionDto,
  ): Promise<{ userId: string; status: UserStatus }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Idempotent, matching this codebase's promotion/RSVP/vouch/accept
    // convention: lifting a suspension that is not there is a no-op, not a 409.
    if (user.status !== UserStatus.Suspended) {
      return { userId: user.id, status: user.status };
    }

    await this.dataSource.transaction(async (manager) => {
      await this.restoreUser(manager, user.id);
      await this.writeAuditLog(
        dto.reportId ?? null,
        actorId,
        'suspension_lifted',
        dto.reasonCode,
        dto.note,
        undefined,
        manager,
      );
    });

    return { userId: user.id, status: UserStatus.Active };
  }

  // --- enforcement ---

  /**
   * Applies a moderator action to the reported *member*, if the action is one
   * that has an effect on an account.
   *
   * Returns the suspended user's id so the caller can revoke their sessions
   * outside the transaction, or `null` when the action was not an enforcement
   * action.
   *
   * `restrict` is deliberately NOT handled here: there is no scoped-restriction
   * model in this codebase to write to. It continues to resolve the report and
   * write an audit row, and has NO enforcement effect. That is a known gap, not
   * an oversight — do not read its absence as "already handled".
   */
  private async enforceAgainstUser(
    manager: EntityManager,
    report: Report,
    dto: { action: ModActionCode; duration?: string },
  ): Promise<string | null> {
    if (dto.action !== 'suspend' && dto.action !== 'ban') {
      return null;
    }

    // Suspending the author of reported *content* is not possible here: the
    // author of a post/reply/message is not resolvable within this module (see
    // the note in `buildDetail`). Failing loudly beats the silent no-op this
    // whole change exists to remove.
    if (report.subjectType !== ReportSubjectType.Member) {
      throw new BadRequestException(
        `Cannot ${dto.action} for a "${report.subjectType}" report — that action applies to members only.`,
      );
    }

    const profile = await this.resolveReportedProfile(report);
    if (!profile) {
      throw new BadRequestException(
        'Could not resolve the reported member to an account.',
      );
    }
    const userId = profile.userId;

    const now = new Date();
    // `ban` is permanent (NULL never expires); `suspend` is time-boxed.
    // Requiring exactly one of these shapes means a missing or malformed
    // duration can never quietly become a permanent ban.
    if (dto.action === 'suspend' && !dto.duration) {
      throw new BadRequestException('A suspension requires a duration.');
    }
    if (dto.action === 'ban' && dto.duration) {
      throw new BadRequestException(
        'A ban is permanent and cannot take a duration. Use "suspend" for a time-limited action.',
      );
    }
    const suspendedUntil =
      dto.action === 'ban' ? null : parseDuration(dto.duration as string, now);

    const user = await manager.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new BadRequestException('Could not suspend the reported member.');
    }

    // A member who had already deactivated keeps `Deactivated` as their live
    // status: they asked to be hidden, and overwriting that would mean this
    // suspension expiring un-hides them later, against their own request. The
    // suspension is still recorded — `previousStatus` below makes them come
    // back Suspended, and `suspendedUntil` keeps the clock — so deactivating
    // is not a way to dodge it either.
    const preserveDeactivation = user.status === UserStatus.Deactivated;

    await manager.update(
      User,
      { id: userId },
      {
        ...(preserveDeactivation ? {} : { status: UserStatus.Suspended }),
        suspendedUntil,
      },
    );

    await this.syncDeactivationPreviousStatus(
      manager,
      userId,
      UserStatus.Suspended,
    );

    return userId;
  }

  /**
   * Clears a suspension and puts the member back in circulation.
   *
   * Mirrors `enforceAgainstUser`: a member who is currently `Deactivated` stays
   * that way. Lifting a suspension restores what they would have been without
   * it, and that is `Deactivated` for someone who had paused their own account
   * — un-hiding them here would be a privilege grant nobody asked for.
   */
  private async restoreUser(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const user = await manager.findOne(User, { where: { id: userId } });
    const preserveDeactivation = user?.status === UserStatus.Deactivated;

    await manager.update(
      User,
      { id: userId },
      {
        ...(preserveDeactivation ? {} : { status: UserStatus.Active }),
        suspendedUntil: null,
      },
    );
    await this.syncDeactivationPreviousStatus(
      manager,
      userId,
      UserStatus.Active,
    );
  }

  /**
   * Keeps an open deactivation row's `previousStatus` in step with a
   * moderation decision.
   *
   * SECURITY: `AccountDeactivation.previousStatus` is what reactivation
   * restores to, and the account controller is deliberately JWT-only (no
   * `ActiveMemberGuard`) so a suspended member CAN reach
   * `POST /account/deactivate`. Without this, suspending an already-deactivated
   * member would leave `previousStatus = 'active'`, and signing back in would
   * launder the suspension away in one click — the exact attack that column was
   * added to prevent. The restore direction matters for the same reason in
   * reverse: a lifted suspension must not be re-applied on reactivation.
   */
  private async syncDeactivationPreviousStatus(
    manager: EntityManager,
    userId: string,
    status: UserStatus,
  ): Promise<void> {
    await manager.update(
      AccountDeactivation,
      { userId, reactivatedAt: IsNull() },
      { previousStatus: status },
    );
  }

  /**
   * `report.subjectId` → `users.id`, for member subjects.
   *
   * Subjects are addressed differently across domains, so a member may be
   * recorded by slug or by uuid (see `Report`'s entity doc). Shared with
   * `describeReported` so the read path and the enforcement path can never
   * disagree about who a report is actually about — a drift there would mean
   * suspending someone other than the person shown in the drawer.
   */
  private async resolveReportedProfile(
    report: Report,
  ): Promise<Profile | null> {
    if (report.subjectType !== ReportSubjectType.Member) return null;
    const where = UUID_RE.test(report.subjectId)
      ? [{ slug: report.subjectId }, { userId: report.subjectId }]
      : [{ slug: report.subjectId }];
    return this.profiles.findOne({ where });
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
    // An erased reporter (`reporter_id` NULLed by the erasure sweep) becomes
    // indistinguishable from an anonymous one — which is exactly right: the
    // report stands, the person behind it is no longer identifiable. Reusing
    // the existing `{ anonymous: true }` arm keeps `ModReporterDTO.id`
    // honestly non-nullable instead of inventing a placeholder id.
    if (!report.reporterId) return { anonymous: true };
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

    // Shared with the enforcement path so the person shown in the drawer and
    // the person a `suspend` actually lands on can never diverge.
    const profile = await this.resolveReportedProfile(report);
    if (profile) {
      return { id: profile.userId, handle: profile.slug, priorReports };
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

  // `null` is the erased-account case: `reports.reporter_id` and
  // `mod_audit_logs.actor_id` are NULLed rather than cascaded when a member
  // exercises their right to erasure, so the moderation record outlives them.
  // There is no one left to name — say so plainly rather than falling through
  // to a lookup that would return the generic 'Member'.
  private async nameForUserId(userId: string | null): Promise<string> {
    if (!userId) return 'Deleted member';
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
    // Nullable since `AddModerationEnforcement1782800800000`: a suspension
    // lifted outside the context of a specific report has no report to hang
    // off, and a placeholder id would be a lie in an immutable trail. Such a
    // row does not appear in any `GET /mod/reports/audit` response, which
    // filters by `reportId` — there is no global audit feed yet.
    reportId: string | null,
    actorId: string,
    action: string,
    reasonCode?: string,
    note?: string,
    duration?: string,
    // When inside a transaction, pass the manager so the audit row commits
    // with the action it records instead of surviving a rollback.
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager ? manager.getRepository(ModAuditLog) : this.auditLogs;
    await repo.save(
      repo.create({
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
