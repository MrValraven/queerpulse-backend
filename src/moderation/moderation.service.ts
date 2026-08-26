import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  IsNull,
  LessThan,
  Not,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { SUPPORT_OPEN_REPORT_THRESHOLD } from '../admin-communities/admin-communities-response';
import { AuthService } from '../auth/auth.service';
import { isUniqueViolation } from '../common/db-errors';
import { CursorKeyset, cursorPaginate } from '../common/cursor-pagination';
import { CommunityMembershipService } from '../communities/community-membership.service';
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
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import {
  ListModReportsQuery,
  ModReportsSort,
  ModReportsTab,
} from './dto/list-mod-reports.query';
import { AuditFeedQuery } from './dto/audit-feed.query';
import { CreateAppealDto } from './dto/create-appeal.dto';
import { ModActionCode, ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ReasonCode } from '../reports/reason-catalogue';
import { formatReportReference } from '../reports/report-reference';
import { ReviewAppealDto } from './dto/review-appeal.dto';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModAuditService } from './mod-audit.service';
import { statusForAction } from './mod-action-status';
import { COMMUNITY_BAN_AUDIT_ACTION } from '../communities/community-governance-log.service';
import { BAN_PENDING_AUDIT_ACTION } from './ban-ratification-window';
import { BanRatificationService } from './ban-ratification.service';
import { BanRatificationStatus } from './entities/ban-ratification.entity';
import { RatifyBanDto } from './dto/ratify-ban.dto';
import {
  APPEAL_FILING_WINDOW_DAYS,
  appealDecisionDueAt,
  appealFilingWindowClosesAt,
  isWithinAppealFilingWindow,
} from './appeal-window';
import { ListAppealsQuery, ModAppealsTab } from './dto/list-appeals.query';
import { ReportSubjectResolverService } from './report-subject-resolver.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ACCOUNT_REMOVED,
  AccountRemovedEvent,
} from '../ban-evasion/ban-evasion.events';
import { RemovalKind } from '../ban-evasion/entities/removed-account-signal.entity';
import {
  AppealAppellant,
  AppealDTO,
  AppealOriginal,
  AuditEntryDTO,
  BanRatificationDTO,
  AuditFeedResponseDTO,
  MemberAppealDTO,
  ModAppealsResponse,
  ModCounts,
  ModReportDetail,
  ModReportClusterDTO,
  ModReportDTO,
  ModReportedDTO,
  ModReporterDTO,
  ModReportsResponse,
  ResolutionNotifiedParty,
  SubmittedAppealDTO,
  toAppealDTO,
  toMemberAppealDTO,
  toModReportDTO,
  toResolutionDTO,
  toSubmittedAppealDTO,
} from './moderation-response';

const DEFAULT_LIMIT = 20;

/**
 * TS-06 surge thresholds: how big a pile on ONE `(subjectType, subjectId)`
 * pair has to be before the queue calls it a surge.
 *
 * These are the auto-freeze thresholds, deliberately. `CommunityAutoFreezeService`
 * already decides "this is a pile-up, not thirty independent complaints" with
 * exactly this pair of numbers one layer down (`isReportPileUp`: at least
 * SUPPORT_OPEN_REPORT_THRESHOLD open reports AND at least three DIFFERENT
 * people behind them), and a queue that drew the line somewhere else would
 * disagree with the freeze a moderator is looking at.
 *
 * `MIN_PILEUP_REPORTERS` is module-private over there, so the value is
 * restated here rather than imported. The distinct-reporter floor is the half
 * that matters: without it, one determined member filing under five different
 * reason codes reads as a surge.
 */
const SURGE_MIN_OPEN_REPORTS = SUPPORT_OPEN_REPORT_THRESHOLD;
const SURGE_MIN_DISTINCT_REPORTERS = 3;

/**
 * How many report ids one cluster carries back. Matches `ModBulkActionDto`'s
 * `@ArrayMaxSize(100)`, so "action the whole pile" is always a single
 * `PATCH /mod/reports/bulk` the server will accept.
 */
const CLUSTER_ID_CAP = 100;

/** One raw row of the TS-06 cluster aggregate (see `clustersFor`). Every
 *  count is cast to `int` in SQL so it arrives as a number rather than the
 *  string node-postgres returns for a `bigint`. */
interface ClusterAggregateRow {
  subjectType: ReportSubjectType;
  subjectId: string;
  openCount: number;
  distinctReporterCount: number;
  overdueCount: number;
  severityRank: number;
  firstReportedAt: string | Date;
  lastReportedAt: string | Date;
  reportIds: string[] | null;
}

/** Severity, ranked most severe first, for the `MIN(...)` in the cluster
 *  aggregate. Postgres enum ordering follows label creation order, which is
 *  not something a query should quietly depend on. */
const SEVERITY_RANK: ReportSeverity[] = [
  ReportSeverity.Emergency,
  ReportSeverity.High,
  ReportSeverity.Medium,
  ReportSeverity.Low,
];

// The moderator actions a member can actually appeal — the ones that land on
// an account or its content. `dismiss`/`escalate` and the appeal bookkeeping
// actions (`appeal_upheld`, `suspension_lifted`, `restriction_lifted`, …) are
// not contestable outcomes, so they never become the target of a fresh appeal.
const APPEALABLE_ACTIONS = [
  'warn',
  'hide_content',
  'remove_content',
  'restrict',
  'suspend',
  'ban',
  // TS-12. A ban held for a second moderator's signature has already suspended
  // the member (see `BAN_INTERIM_SUSPENSION`), so it is a real consequence they
  // are living under and must be contestable while it stands. An overturned
  // appeal against it also withdraws the hold, so the second moderator cannot
  // ratify a ban the appeal has already reversed
  // (`revertOriginalAction`).
  BAN_PENDING_AUDIT_ACTION,
  // TS-11, step 5, and the reason this list is not just platform actions any
  // more. A community ban writes `community_ban_applied` with no report and the
  // barred member in `target_user_id` (wave 2,
  // `community-governance-log.service.ts`). Until it was appealable here, the
  // member was told to "contact its moderators", which the product offers no
  // way to do.
  COMMUNITY_BAN_AUDIT_ACTION,
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
    // Backs the community-owner/mod carve-out in `actOnReport` — see
    // `assertCanActOnReport` — and, since TS-14, the community-id -> slug
    // lookup the queue rows carry (`refsByIds`/`slugById`). Read-only,
    // entity-registration-only module (`CommunityMembershipModule`), not the
    // full `CommunitiesModule`.
    private readonly communityMembership: CommunityMembershipService,
    // Resolves a report's subject to its author, its excerpt and its owning
    // community, for every subject type. Read-only, holds only the
    // `DataSource`, so it adds no edge to the module graph.
    private readonly subjectResolver: ReportSubjectResolverService,
    // Emits `ACCOUNT_REMOVED` after a permanent ban commits, so the ban-evasion
    // module can keep correlation material for the invite review queue.
    private readonly eventEmitter: EventEmitter2,
    // TS-12. The queue's link to the second-moderator hold a `ban` now opens:
    // this facade exposes the pending queue and the ratify/decline decision on
    // `/mod/ratifications`, and withdraws a hold when an appeal overturns the
    // ban it was for.
    private readonly banRatification: BanRatificationService,
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
  // audit named "warned" first, and since TS-02 it reaches the author of
  // reported content, not only the subject of a `member` report. `restrict` was added once `enforceAgainstUser`
  // started giving it a real, time-boxed effect (previously a no-op, so there
  // was nothing to report) — it reuses the exact suspend/ban notification path
  // via `resolveOutcomeTarget`'s `enforceResult` fallback below.
  private static readonly OUTCOME_ACTIONS = new Set<string>([
    'warn',
    'restrict',
    'suspend',
    'ban',
  ]);

  /**
   * What a community owner/mod may do to a report on their own community's
   * post or reply, without holding a platform Moderator/Admin role. See
   * `assertCanActOnReport` for every condition attached to it.
   *
   * `remove_content` is here since TS-08. The community console used to take a
   * post down through the community delete endpoint and then close the report
   * with `dismiss`, so the audit log, the resolution block and the admin badge
   * all read "Dismissed" for the single most common community action, and no
   * `content_moderation` row was ever written. Anyone auditing that community
   * read "dismissed" over and over and concluded its moderators did nothing.
   * Sending the real action instead means the takedown and the report close
   * commit together in one transaction, exactly as the platform path already
   * does, and the appeal machinery finally has a true record to rest on.
   *
   * `escalate` is here since TS-07, so an emergency report a community mod may
   * not settle has somewhere to go.
   *
   * Everything else (warn/suspend/ban/restrict/hide_content) stays platform
   * staff only: those are account-level or platform-wide consequences.
   */
  private static readonly COMMUNITY_MOD_ACTIONS = new Set<ModActionCode>([
    'dismiss',
    'remove_content',
    'escalate',
  ]);

  // GET /mod/reports — filterable, cursor-paginated queue. `tab` (not
  // `status`, which the frontend never sends — C4) is mapped to a status
  // filter server-side. The envelope is now the shared `CursorPage`
  // (`{ data, pageInfo: { nextCursor, hasMore } }`) every other list endpoint
  // uses, with the queue's real per-tab `counts` carried alongside it — the
  // former one-off `{ items, counts, page: { cursor } }` outlier is gone.
  async list(
    query: ListModReportsQuery,
    actorId?: string,
  ): Promise<ModReportsResponse> {
    const qb = this.reports.createQueryBuilder('r');
    this.applyTabFilter(qb, query.tab);

    if (query.subjectType) {
      qb.andWhere('r.subjectType = :subjectType', {
        subjectType: query.subjectType,
      });
    }
    if (query.subjectId) {
      qb.andWhere('r.subjectId = :subjectId', { subjectId: query.subjectId });
    }
    if (query.severity) {
      qb.andWhere('r.severity = :severity', { severity: query.severity });
    }
    if (query.community) {
      this.applyCommunityFilter(qb, query.community);
    }
    if (query.filter === 'emergencies') {
      qb.andWhere('r.severity = :emergencySeverity', {
        emergencySeverity: ReportSeverity.Emergency,
      });
    }
    // `filter: 'mine'` (COM-5): the caller's own claimed reports, via the
    // `assigned_moderator_id` column (`AddReportAssignee`) + the self-assign/
    // unassign `PATCH /mod/reports/:id/assignment` route. `actorId` is always
    // present when this filter can fire — `ModerationController.listReports`
    // passes the authenticated moderator's id — but guard anyway so a
    // hypothetical unauthenticated caller sees an empty result, never
    // everyone else's assigned reports.
    if (query.filter === 'mine') {
      qb.andWhere('r.assignedModeratorId = :actorId', {
        actorId: actorId ?? null,
      });
    }
    // TS-06's two triage filters. `overdue` is the SLA window that has already
    // closed on a report nobody has decided yet; `surge` is the pile-on shape
    // the flat queue could not show.
    if (query.filter === 'overdue') {
      qb.andWhere('r.slaDueAt < now()').andWhere(
        'r.status != :resolvedForOverdue',
        { resolvedForOverdue: ReportStatus.Resolved },
      );
    }
    if (query.filter === 'surge') {
      this.applySurgeFilter(qb);
    }
    // `sort` is now actually honoured (BE-COM-11): it was validated by the
    // DTO and then never read, so every listing came back newest-first
    // whatever the queue asked for — and newest-first is the one ordering the
    // "emergency within 1h" SLA can't be worked from. `undefined` keeps the
    // default `(created_at, id) DESC` page.
    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      query.cursor,
      query.limit ?? DEFAULT_LIMIT,
      'r',
      // `reports.created_at` is `timestamptz(3)` since
      // `NarrowReportCursorPrecision1793520300000`, so the default path can
      // order on the raw column instead of a non-indexable `date_trunc`.
      true,
      ModerationService.keysetForSort(query.sort),
    );

    const [items, counts, clusters] = await Promise.all([
      this.toRows(rows),
      this.computeCounts(),
      this.clustersFor(rows),
    ]);

    return { data: items, pageInfo: { nextCursor, hasMore }, counts, clusters };
  }

  /**
   * The alternate cursor keyset for a requested `sort`, or `undefined` for the
   * default newest-first page.
   *
   * `priority` pages on `sla_due_at` ASC — soonest-due first. That column is
   * derived from `severity` at creation (`report-severity.ts`: emergency is
   * +1h, low is days out), so ordering by it IS "most severe, then oldest"
   * without a `CASE severity WHEN ...` expression no index could serve.
   * `age` pages on `created_at` ASC — oldest first.
   *
   * Both columns are `timestamptz(3)` and both have a matching `(column, id)`
   * ASC index (see `NarrowReportCursorPrecision1793520300000`); the precision
   * is what makes the raw-column keyset safe against duplicate rows at a page
   * boundary.
   */
  private static keysetForSort(
    sort: ModReportsSort | undefined,
  ): CursorKeyset<Report> | undefined {
    if (sort === 'priority') {
      return {
        columnExpr: '"r"."sla_due_at"',
        direction: 'ASC',
        kind: 'date',
        getValue: (row) => row.slaDueAt,
      };
    }
    if (sort === 'age') {
      return {
        columnExpr: '"r"."created_at"',
        direction: 'ASC',
        kind: 'date',
        getValue: (row) => row.createdAt,
      };
    }
    return undefined;
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
  //
  // The controller only requires an active member for this one route (its
  // class-level `@Roles(Moderator, Admin)` is overridden here) — see
  // `assertCanActOnReport` for the actual authorization: platform
  // Moderator/Admin (unchanged), OR a community owner/mod dismissing,
  // removing or escalating a report scoped to a post/reply in the community
  // they moderate.
  async actOnReport(
    id: string,
    actorId: string,
    actorRole: string,
    dto: ModActionDto,
  ): Promise<ModReportDTO> {
    const report = await this.findReportOrThrow(id);
    const hasFullReportVisibility = await this.assertCanActOnReport(
      report,
      actorId,
      actorRole,
      dto.action,
    );
    // The report's own state machine (BE-COM-03): `open -> resolved |
    // escalated`, `escalated -> resolved`, and `resolved` is TERMINAL. Nothing
    // used to read `report.status` here at all, so a resolved report could be
    // acted on again — re-running `enforceAgainstUser` (a second suspension,
    // another `revokeAllForUser`), overwriting the resolution block with a new
    // actor/action, appending another audit row and re-notifying the reporter.
    const expectedStatus = ModerationService.assertActionableStatus(report);

    // Report status, enforcement against the member, and the audit row commit
    // together or not at all. A resolved report whose suspension failed to
    // write is exactly the bug this method exists to fix, in a subtler form.
    const { saved, enforceResult } = await this.dataSource.transaction(
      async (manager) => {
        // Claim the transition with a conditional UPDATE before doing anything
        // consequential — the same race-safe pattern
        // `CommunitiesService.triageJoinRequest` uses. Two moderators acting on
        // the same report concurrently both reach here; the second blocks on
        // this row lock, then sees the committed status and loses with
        // `affected === 0`, so enforcement runs exactly once.
        const claimed = await manager.update(
          Report,
          { id: report.id, status: expectedStatus },
          { status: statusForAction(dto.action) },
        );
        if (claimed.affected !== 1) {
          throw new ConflictException(
            'This report has already been actioned by someone else.',
          );
        }

        const enforceResult = await this.accountEnforcement.enforceAgainstUser(
          manager,
          report,
          dto,
          actorId,
        );

        // TS-12. A `ban` that is waiting on a second moderator has not banned
        // anyone, and the immutable trail must say so. The audit row reads
        // `ban_pending_ratification` and carries the hold's expiry as its
        // duration; the canonical `ban` row is written later, by the moderator
        // who actually ratifies it.
        const auditAction =
          enforceResult?.kind === 'ban_pending'
            ? BAN_PENDING_AUDIT_ACTION
            : dto.action;
        const auditDuration =
          enforceResult?.kind === 'ban_pending'
            ? (enforceResult.suspendedUntil?.toISOString() ?? undefined)
            : dto.duration;

        report.status = statusForAction(dto.action);
        if (report.status === ReportStatus.Resolved) {
          await this.applyResolution(
            report,
            actorId,
            dto,
            enforceResult,
            auditAction,
            auditDuration,
          );
        }
        const saved = await manager.save(report);

        await this.audit.writeAuditLog(
          saved.id,
          actorId,
          auditAction,
          dto.reasonCode,
          dto.note,
          auditDuration,
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
    // member is already locked out with or without this. Skipped for
    // `restrict`: a restriction is deliberately not a lockout (see
    // `AccountEnforcementService.enforceAgainstUser`), so signing the member
    // out of every device would be a stronger consequence than the action
    // taken.
    if (enforceResult && enforceResult.kind !== 'restrict') {
      await this.auth.revokeAllForUser(enforceResult.userId);
    }

    // Ban evasion (TS-05). A permanent ban is the enforcement that means "this
    // account is gone", so it is the one that leaves correlation material
    // behind for the invite review queue. Emitted post-commit and deliberately
    // outside the transaction: failing to record a signal must never roll back
    // a ban that has already taken effect.
    //
    // SINCE TS-12 THIS CANNOT FIRE FROM HERE, and the branch is kept so that
    // stays visible rather than becoming a silent hole. `enforceAgainstUser`
    // answers `ban_pending` for a `ban` now: the account has been suspended for
    // the length of a ratification hold and nothing has been removed. The emit
    // moved to `BanRatificationService.decide`, which runs it at the instant a
    // second moderator confirms the ban, because "this account is gone" is only
    // true then. Emitting on the hold would seed the invite review queue with
    // correlation material about members whose bans lapse unratified.
    if (enforceResult && enforceResult.kind === 'ban') {
      const removed: AccountRemovedEvent = {
        userId: enforceResult.userId,
        removalKind: RemovalKind.PlatformBan,
        communityId: null,
        removedAt: new Date(),
      };
      this.eventEmitter.emit(ACCOUNT_REMOVED, removed);
    }

    await this.notifyReporterOfOutcomeBestEffort(saved, actorId);

    // Tell the *sanctioned member* the outcome and why (warn/suspend/ban) — the
    // gap the audit named. Best-effort, post-commit, same as the reporter path.
    await this.notifyModerationOutcome(
      actorId,
      dto,
      await this.resolveOutcomeTarget(report, dto, enforceResult),
      enforceResult?.kind,
    );

    // `hasFullReportVisibility` is false exactly when the caller authorized
    // through the community-mod carve-out below (never through the platform
    // Moderator/Admin fast path) — `toRow` uses it to withhold the
    // reporter/reported/assigned-moderator detail a community mod has no
    // business seeing (see `assertCanActOnReport`'s doc comment: "This grants
    // no report visibility").
    return this.toRow(saved, false, hasFullReportVisibility);
  }

  /**
   * Authorization for `actOnReport`, called after the report is resolved so a
   * community mod's own community can be checked against the real subject.
   * Returns whether the caller authorized as platform staff — `actOnReport`
   * uses this to decide how much of the report `toRow` may disclose back to
   * them.
   *
   * A platform Moderator/Admin may take any action on any report, unchanged,
   * and gets the full response (`true`). Everything else is a narrow,
   * community-scoped carve-out over three actions
   * ({@link COMMUNITY_MOD_ACTIONS}) on a report whose subject resolves to a
   * post or reply in the community they own or moderate — and gets back
   * `false`. Everyone else, including a community mod acting outside their own
   * community or against a non-community-post/reply report (member, message,
   * venue, ...), is forbidden. This grants no report *visibility*:
   * `GET /mod/reports` and `GET /mod/reports/:id` are untouched and still
   * require the platform role, and the community-mod carve-out's own PATCH
   * response is redacted by `toRow` using the `false` returned here.
   */
  private async assertCanActOnReport(
    report: Report,
    actorId: string,
    actorRole: string,
    action: ModActionCode,
  ): Promise<boolean> {
    // `actorRole` arrives as the JWT claim's plain `string` (see
    // `CurrentUserData.role`) — cast once here to compare against the enum,
    // same pattern as `HousingModerationGuard`/`PlatformLockdownGuard`.
    const role = actorRole as UserRole;
    if (role === UserRole.Moderator || role === UserRole.Admin) {
      return true;
    }

    if (ModerationService.COMMUNITY_MOD_ACTIONS.has(action)) {
      // The carve-out is narrower than the role check above in four ways:
      //  - only while the report is still OPEN (BE-COM-03). A report a PLATFORM
      //    moderator escalated is out of a community mod's hands by definition:
      //    `escalated` means "send this up", and letting the community it came
      //    from close it undoes that decision.
      //  - never at EMERGENCY severity, except to escalate it (TS-07). See
      //    `assertCommunityModMaySettle`.
      //  - never on their OWN content, for the two actions that settle the
      //    report. `isOwnerOrMod` says the actor moderates the community, not
      //    that they are impartial about this report; a community moderator
      //    reported for their own post could otherwise close the report about
      //    themselves in one call, platform-wide.
      //  - unchanged: only for a post/reply inside a community they moderate.
      if (report.status !== ReportStatus.Open) {
        throw new ForbiddenException(
          'This report is no longer open to a community moderator. Platform staff will decide it.',
        );
      }
      ModerationService.assertCommunityModMaySettle(report, action);
      const communityId = await this.communityIdForReportSubject(report);
      if (
        communityId &&
        (await this.communityMembership.isOwnerOrMod(communityId, actorId))
      ) {
        // Escalating is the one action that hands the report to somebody else
        // rather than settling it, so it stays available on the moderator's
        // own content: sending a report about yourself upward is never
        // self-dealing, and blocking it would leave that report stuck.
        if (action !== 'escalate') {
          const subjectAuthorId = await this.authorIdForReportSubject(report);
          if (subjectAuthorId === actorId) {
            throw new ForbiddenException(
              'You cannot close a report about your own post. Platform staff will decide it.',
            );
          }
        }
        return false;
      }
    }

    throw new ForbiddenException(
      "Requires a moderator or admin role, or ownership/moderation of the report's community to dismiss, remove or escalate it.",
    );
  }

  /**
   * TS-07: an EMERGENCY report is not a community moderator's to settle.
   *
   * `report-severity.ts` maps `outing` and `doxxing` to
   * `ReportSeverity.Emergency`, and both are the report a community's own
   * moderators are least able to decide: the community whose mods are the
   * problem, or who are simply out of their depth, could close it before
   * trained staff ever saw it, and a dismissal is platform-wide and terminal.
   * The carve-out never guarded against that. It only guarded against a mod
   * closing a report about their own post.
   *
   * `escalate` is deliberately still allowed, and is why this refusal can name
   * an alternative rather than being a dead end: the community moderator who
   * finds an outing post keeps a way to put it in front of the people trained
   * for it, immediately.
   */
  private static assertCommunityModMaySettle(
    report: Report,
    action: ModActionCode,
  ): void {
    if (report.severity !== ReportSeverity.Emergency) return;
    if (action === 'escalate') return;
    throw new ForbiddenException(
      'This report is about outing or doxxing, so it goes to trained platform staff. Escalate it and they will pick it up.',
    );
  }

  /**
   * The status a report must still be in for an action to land on it, or a
   * 409 when it is already terminal.
   *
   * `resolved` is the end of the line: acting again would re-run enforcement,
   * overwrite the recorded resolution with a different actor and action, and
   * re-notify the reporter about a decision that was already communicated.
   * `open` and `escalated` are both actionable — `escalated -> resolved` is
   * how an escalated report is finally decided — and the value returned here
   * becomes the `WHERE status = ...` guard on the claiming UPDATE, so a
   * concurrent action can't slip between this read and that write.
   */
  private static assertActionableStatus(report: Report): ReportStatus {
    if (report.status === ReportStatus.Resolved) {
      throw new ConflictException('This report has already been resolved.');
    }
    return report.status;
  }

  // The member who wrote the reported post/reply, for the conflict-of-interest
  // check on the community-mod carve-out. Null for any other subject
  // type, an unresolvable id, or an erased author — none of which can equal a
  // live `actorId`, so the check fails open to "not your own content" only
  // when there genuinely is no author to match.
  private async authorIdForReportSubject(
    report: Report,
  ): Promise<string | null> {
    if (report.subjectType === ReportSubjectType.Post) {
      return this.communityMembership.authorIdForPost(report.subjectId);
    }
    if (report.subjectType === ReportSubjectType.Reply) {
      return this.communityMembership.authorIdForReply(report.subjectId);
    }
    return null;
  }

  // Resolves a report's `subjectType`/`subjectId` to the community it belongs
  // to, for a `post`/`reply` subject only — mirrors the exact resolution
  // pattern `CommunityAutoFreezeService.resolveCommunity` and
  // `CommunityPostsService.listCommunityReports` already establish (a report
  // on the community itself, a member, a message, etc. resolves to `null`
  // here; this carve-out is about content *inside* a community, not the
  // community-as-subject case).
  private async communityIdForReportSubject(
    report: Report,
  ): Promise<string | null> {
    if (report.subjectType === ReportSubjectType.Post) {
      return this.communityMembership.communityIdForPost(report.subjectId);
    }
    if (report.subjectType === ReportSubjectType.Reply) {
      return this.communityMembership.communityIdForReply(report.subjectId);
    }
    return null;
  }

  // POST /mod/reports/bulk — applies one action to many reports, writing an
  // audit log row per report actually found. Unknown ids are silently
  // skipped. Continue-on-error (P0-16): each report is applied in its OWN
  // transaction, so one report failing (e.g. `ban` against a non-member-
  // subject report slipped into a mixed selection) can no longer roll back
  // every other report in the batch — the previous single-transaction
  // implementation meant one bad row silently failed the whole selection. The
  // response now reports both halves instead of a single all-or-nothing list.
  async bulkActOnReports(
    actorId: string,
    dto: ModBulkActionDto,
  ): Promise<{
    updated: string[];
    failed: { id: string; reason: string }[];
  }> {
    const rows = await this.reports.find({ where: { id: In(dto.ids) } });
    if (!rows.length) return { updated: [], failed: [] };

    const status = statusForAction(dto.action);

    const updated: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    // Each report paired with its enforcement result, so the post-commit pass
    // can revoke sessions AND notify the right member with the right expiry —
    // only for the reports that actually committed.
    const outcomes: Array<{
      report: Report;
      enforceResult: {
        userId: string;
        suspendedUntil: Date | null;
        kind: 'suspend' | 'ban' | 'restrict' | 'ban_pending';
      } | null;
    }> = [];

    for (const report of rows) {
      try {
        // Same state machine as the single-report path (BE-COM-03). A report
        // already `resolved` is terminal, and a mixed selection that happens
        // to include one must not silently re-enforce against its subject —
        // it lands in `failed` with a reason, which is exactly what this
        // method's continue-on-error contract is for.
        const expectedStatus = ModerationService.assertActionableStatus(report);
        const enforceResult = await this.dataSource.transaction(
          async (manager) => {
            // Race-safe claim before any consequence — see `actOnReport`.
            const claimed = await manager.update(
              Report,
              { id: report.id, status: expectedStatus },
              { status },
            );
            if (claimed.affected !== 1) {
              throw new ConflictException(
                'This report has already been actioned by someone else.',
              );
            }

            const enforceResult =
              await this.accountEnforcement.enforceAgainstUser(
                manager,
                report,
                dto,
                actorId,
              );

            // TS-12, and the half of it that matters most: a bulk `ban` across
            // 100 reports opens 100 ratification HOLDS, never 100 removals.
            // `enforceAgainstUser` is idempotent per member, so thirty reports
            // about one person join one hold rather than stacking thirty. The
            // audit row on each report says the ban is pending.
            const auditAction =
              enforceResult?.kind === 'ban_pending'
                ? BAN_PENDING_AUDIT_ACTION
                : dto.action;
            const auditDuration =
              enforceResult?.kind === 'ban_pending'
                ? (enforceResult.suspendedUntil?.toISOString() ?? undefined)
                : dto.duration;

            report.status = status;
            if (status === ReportStatus.Resolved) {
              await this.applyResolution(
                report,
                actorId,
                dto,
                enforceResult,
                auditAction,
                auditDuration,
              );
            }
            await manager.save(report);

            await this.audit.writeAuditLog(
              report.id,
              actorId,
              auditAction,
              dto.reasonCode,
              dto.note,
              auditDuration,
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

            return enforceResult;
          },
        );

        outcomes.push({ report, enforceResult });
        updated.push(report.id);
      } catch (error) {
        failed.push({
          id: report.id,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Same `restrict` carve-out as the single-report path above: a restriction
    // is deliberately not a lockout, so it must not sign the member out of
    // every device.
    const suspendedUserIds = outcomes
      .filter((outcome) => outcome.enforceResult?.kind !== 'restrict')
      .map((outcome) => outcome.enforceResult?.userId)
      .filter((userId): userId is string => Boolean(userId));
    for (const userId of new Set(suspendedUserIds)) {
      await this.auth.revokeAllForUser(userId);
    }

    // Notify each sanctioned member of the outcome — one row per report, so a
    // member named in several reports of the same batch hears about each. Same
    // best-effort, post-commit contract as the single-report path. Only for
    // reports that actually committed — `outcomes` never carries a failed one.
    //
    // Each REPORTER hears too, through the same method the single-report path
    // uses. Batch-actioning a queue is how most reports are actually closed, so
    // leaving this out meant the majority of reporters got nothing at all — see
    // `notifyReporterOfOutcomeBestEffort` for what they are and are not told.
    for (const { report, enforceResult } of outcomes) {
      await this.notifyModerationOutcome(
        actorId,
        dto,
        await this.resolveOutcomeTarget(report, dto, enforceResult),
        enforceResult?.kind,
      );
      await this.notifyReporterOfOutcomeBestEffort(report, actorId);
    }

    return { updated, failed };
  }

  /**
   * The member an outcome notification should reach, plus a suspension's expiry
   * when there is one.
   *
   * `warn` does no account enforcement (so `enforceResult` is null for it), so
   * it resolves the member itself: the reported member on a `member` report,
   * and the AUTHOR of the reported content on every other subject type
   * (TS-02). Before that, a `warn` on a post, reply, message, comment or review
   * — most of the queue — closed the report and logged "warned" while notifying
   * nobody at all, so the team believed it was running a graduated ladder while
   * the member heard nothing. `suspend`/`ban`/`restrict` reuse the account the
   * enforcement already landed on, carrying its expiry (`null` = permanent
   * ban). Any non-outcome action yields null, as does a subject with no
   * resolvable author (a `venue` report describing a place in prose, an erased
   * author) — the honest answer, rather than warning the wrong person.
   */
  private async resolveOutcomeTarget(
    report: Report,
    dto: { action: ModActionCode },
    enforceResult: { userId: string; suspendedUntil: Date | null } | null,
  ): Promise<{ userId: string; expiresAt: Date | null } | null> {
    if (!ModerationService.OUTCOME_ACTIONS.has(dto.action)) return null;
    if (dto.action === 'warn') {
      const resolution = await this.subjectResolver.resolve(report);
      return resolution.authorUserId
        ? { userId: resolution.authorUserId, expiresAt: null }
        : null;
    }
    return enforceResult
      ? {
          userId: enforceResult.userId,
          expiresAt: enforceResult.suspendedUntil,
        }
      : null;
  }

  /**
   * Writes the resolution block (COM-7) onto `report` IN PLACE — mutates the
   * entity the caller is about to `manager.save()`, rather than returning a
   * value, so `actOnReport`/`bulkActOnReports` can call this right where they
   * already set `report.status = statusForAction(...)` and fold it into the
   * same save. Only called when the action actually resolves the report
   * (never for `escalate`).
   *
   * `notified` is computed from the same facts the post-commit notification
   * pass below uses — a target resolves (member) and/or the report has a
   * reachable, non-self reporter — so the resolution block can never claim a
   * party was notified that `notifyModerationOutcome`/the reporter-notify
   * block wouldn't actually reach. It does not depend on whether that
   * best-effort send later succeeds, matching how those notifications are
   * already "fire and don't roll back the decision" (see their own doc
   * comments).
   */
  private async applyResolution(
    report: Report,
    actorId: string,
    dto: {
      action: ModActionCode;
      reasonCode: ReasonCode;
      note?: string;
      duration?: string;
    },
    enforceResult: { userId: string; suspendedUntil: Date | null } | null,
    // What the trail should RECORD, which is not always what the moderator
    // asked for: a `ban` waiting on ratification is recorded as
    // `ban_pending_ratification` with the hold's expiry, so the resolved
    // report's outcome badge cannot claim a member was removed while a second
    // moderator has yet to confirm it (TS-12). Defaults to the action itself.
    recordedAction: string = dto.action,
    recordedDuration: string | undefined = dto.duration,
  ): Promise<void> {
    // Resolved from the action the moderator ASKED for, never the recorded one:
    // this decides WHO hears about the outcome, and a pending ban still lands
    // on the same member a full ban would have.
    const outcomeTarget = await this.resolveOutcomeTarget(
      report,
      dto,
      enforceResult,
    );

    const notified: ResolutionNotifiedParty[] = [];
    if (outcomeTarget && outcomeTarget.userId !== actorId) {
      notified.push('member');
    }
    if (report.reporterId && report.reporterId !== actorId) {
      notified.push('reporter');
    }

    report.resolvedAt = new Date();
    report.resolutionActorId = actorId;
    report.resolutionAction = recordedAction;
    report.resolutionDuration = recordedDuration ?? null;
    report.resolutionNote = dto.note ?? null;
    report.resolutionNotified = notified;
  }

  /**
   * Tell the REPORTER that the thing they reported has been dealt with.
   *
   * Reporting used to be a one-way door on the bulk path: `actOnReport` sent
   * this, `bulkActOnReports` did not, so whether a reporter ever heard anything
   * depended on whether a moderator happened to tick their row in a batch. Worse,
   * `applyResolution` wrote `'reporter'` into `resolutionNotified` either way,
   * so the resolved report claimed a message had gone out that nothing had sent.
   * Both paths now call this one method, which is also what keeps that claim
   * honest.
   *
   * WHAT THE REPORTER IS TOLD: that their report reached an outcome, which of
   * their reports it was (`reportId` plus the display `reference` they already
   * saw on `GET /reports/mine`), the subject type they themselves chose when
   * filing, and whether it was `resolved` or `escalated`.
   *
   * WHAT THEY ARE DELIBERATELY NOT TOLD: the moderator's identity
   * (`resolutionActorId`), the action taken (`resolutionAction`/
   * `resolutionDuration`), the moderator's internal note (`resolutionNote`), and
   * anything at all about the reported party. A reporter is owed the knowledge
   * that they were heard; they are not owed a consequence report on another
   * member, which would turn the report form into a way to probe whether someone
   * has been sanctioned.
   *
   * Skipped for an anonymous filing with no `reporterId` to reach and when the
   * acting moderator is the reporter. No actor is passed, so this bypasses the
   * block/mute filter and the per-type preference gate exactly like
   * `notifyModerationOutcome`: the outcome of your own report is the platform's
   * word, not a member action. Best-effort and post-commit, so a notification
   * failure can never roll back a decision that has already committed.
   */
  private async notifyReporterOfOutcomeBestEffort(
    report: Report,
    actorId: string,
  ): Promise<void> {
    if (!report.reporterId || report.reporterId === actorId) return;
    try {
      await this.notifications.create(
        report.reporterId,
        NotificationType.ReportResolved,
        {
          source: 'report',
          reportId: report.id,
          reference: formatReportReference(report),
          subjectType: report.subjectType,
          outcome: report.status,
        },
      );
    } catch {
      // Intentionally ignored — the report action already committed.
    }
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
    // The kind of enforcement that actually landed. A `ban` waiting on a
    // second moderator (TS-12) is told to the member as the SUSPENSION it
    // currently is, with the hold's expiry, because that is what is true about
    // their account right now. They hear again, as a ban, if and when a second
    // moderator confirms it (`BanRatificationService.decide`). Telling them
    // they had been banned while the decision is still open would be a
    // statement the software cannot stand behind.
    enforcementKind?: string,
  ): Promise<void> {
    // A moderator acting on their own report never notifies themselves.
    if (!target || target.userId === actorId) return;
    const action = enforcementKind === 'ban_pending' ? 'suspend' : dto.action;
    try {
      await this.notifications.create(
        target.userId,
        NotificationType.ModerationOutcome,
        {
          source: 'moderation',
          action,
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

  /**
   * GET /mod/appeals — the appeals queue, split into the two tabs the published
   * process actually has (TS-11).
   *
   * WHAT THIS REPLACED: one unfiltered, unpaginated `find` capped at 200 rows,
   * newest first, with decided appeals mixed in among the awaiting ones. Newest
   * first is the wrong ordering for a queue with a deadline, because the appeal
   * closest to breaching §05's 7-day window is the OLDEST one, so it sat at the
   * bottom of the list under every appeal that still had a week to run. And a
   * moderator working the queue had to read past decided cases to find the ones
   * that still needed them.
   *
   *  - `awaiting` pages on `sla_due_at` ASC: soonest-due first, so the top of
   *    the list is always the appeal the platform is closest to being late on.
   *  - `decided` pages on the default `(created_at, id) DESC` keyset. It is a
   *    history view, and newest first is the useful order there. It cannot page
   *    on `decided_at` because that column is deliberately NULL for every
   *    appeal decided before it existed (see the entity), and a keyset tuple
   *    comparison against NULL silently drops those rows from every page.
   *
   * Both go through the SAME `cursorPaginate` helper the reports queue uses,
   * with the same millisecond-precision contract behind it, rather than a
   * second pagination scheme that could drift from it.
   */
  async listAppeals(query: ListAppealsQuery = {}): Promise<ModAppealsResponse> {
    const tab: ModAppealsTab = query.tab ?? 'awaiting';
    const now = new Date();

    const qb = this.appeals.createQueryBuilder('a');
    if (tab === 'awaiting') {
      qb.andWhere('a.status = :awaiting', { awaiting: AppealStatus.Awaiting });
    } else {
      qb.andWhere('a.status != :awaiting', { awaiting: AppealStatus.Awaiting });
    }
    // Overdue only ever narrows the awaiting tab: a decided appeal has no
    // window left to be outside of. Whether it was decided late is a fact its
    // own `decidedAt`/`slaDueAt` pair carries, row by row.
    if (query.filter === 'overdue' && tab === 'awaiting') {
      qb.andWhere('a.slaDueAt < :now', { now });
    }

    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      query.cursor,
      query.limit ?? DEFAULT_LIMIT,
      'a',
      // `appeals.created_at` is `timestamptz(3)` since
      // `AddAppealDecisionWindows1794920000000`, so the default path orders on
      // the raw column instead of a non-indexable `date_trunc`.
      true,
      tab === 'awaiting'
        ? {
            columnExpr: '"a"."sla_due_at"',
            direction: 'ASC',
            kind: 'date',
            getValue: (row) => row.slaDueAt,
          }
        : undefined,
    );

    const [data, counts] = await Promise.all([
      this.toAppealRows(rows, now),
      this.appealCounts(now),
    ]);
    return { data, pageInfo: { nextCursor, hasMore }, counts };
  }

  /**
   * The three numbers the appeals header shows. Filter-independent, like
   * `computeCounts()` for the reports queue: a tab count that changed when you
   * filtered would stop being a total.
   */
  private async appealCounts(
    now: Date,
  ): Promise<{ awaiting: number; decided: number; overdue: number }> {
    const [awaiting, decided, overdue] = await Promise.all([
      this.appeals.count({ where: { status: AppealStatus.Awaiting } }),
      this.appeals.count({ where: { status: Not(AppealStatus.Awaiting) } }),
      this.appeals.count({
        where: { status: AppealStatus.Awaiting, slaDueAt: LessThan(now) },
      }),
    ]);
    return { awaiting, decided, overdue };
  }

  // POST /appeals — a member (crucially, possibly a SUSPENDED one, via
  // `AppealSubmitGuard`) contests a moderation decision taken on them. Resolves
  // the specific enforcement action being appealed (best-effort), enforces one
  // open appeal per action, and returns a narrow member-facing acknowledgement.
  async submitAppeal(
    appellantUserId: string,
    dto: CreateAppealDto,
  ): Promise<SubmittedAppealDTO> {
    const now = new Date();
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

    // TS-11: §05 publishes a 14-day filing window, and nothing enforced it.
    // See `appeal-window.ts` for exactly which instant starts the clock and
    // why it is the audit row's `created_at` rather than the report's
    // `resolved_at` or the notification's timestamp.
    //
    // WHERE THERE IS NO RESOLVABLE ACTION, THERE IS NO DEADLINE. A cold appeal
    // (nothing in `mod_audit_logs` matches this member) is let through
    // untouched, deliberately: the software cannot say when the decision was
    // taken, so it has no honest basis for saying the member is late. Refusing
    // one on an invented deadline would turn a gap in our own record into a
    // refusal aimed at the member.
    if (target) {
      const closesAt = appealFilingWindowClosesAt(target.actionAt);
      if (!isWithinAppealFilingWindow(target.actionAt, now)) {
        throw new BadRequestException(
          `Appeals are open for ${APPEAL_FILING_WINDOW_DAYS} days after a decision, and the window for this one closed on ` +
            `${closesAt.toISOString().slice(0, 10)}. If something has changed since, or you could not reach this form in time, ` +
            'write to the moderation team and ask them to look again.',
        );
      }
    }

    try {
      const saved = await this.appeals.save(
        this.appeals.create({
          appellantId: appellantUserId,
          actionId: target?.actionId ?? null,
          reportId: target?.reportId ?? null,
          severity: target?.severity ?? ReportSeverity.Medium,
          // TS-11: hardcoded `null` until now, so every appeal arrived in the
          // moderator queue with no idea which room it came out of. Resolved
          // through the same `ReportSubjectResolverService` the reports queue
          // uses, so an appeal and the report behind it can never disagree
          // about which community they belong to.
          community: target?.community ?? null,
          argument: dto.reason,
          status: AppealStatus.Awaiting,
          // The published 7-day decision window, computed at filing exactly the
          // way `reports.sla_due_at` is computed at report creation.
          slaDueAt: appealDecisionDueAt(now),
          decidedAt: null,
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

  // GET /appeals/me — the calling member's OWN appeals, most recent first.
  // Reachable by a suspended member (same `AppealSubmitGuard` as `POST
  // /appeals`) since that's exactly who needs to check on a filed appeal.
  // Deliberately returns the narrow `MemberAppealDTO`, never the moderator
  // queue's enriched `AppealDTO` — a self-view has no business seeing an
  // appellant handle (it's already them) or the original moderator's name.
  async listMine(appellantUserId: string): Promise<MemberAppealDTO[]> {
    const rows = await this.appeals.find({
      where: { appellantId: appellantUserId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIMIT,
    });
    return rows.map(toMemberAppealDTO);
  }

  /**
   * Resolves which enforcement action a member's appeal is really about, so the
   * appeal lands in the moderator queue with the same context a moderator-side
   * `AppealDTO` carries (`actionId`/`reportId`/`severity`/`community`), and so
   * the 14-day filing window has an instant to be measured from.
   *
   * TWO WAYS AN ACTION BELONGS TO A MEMBER, and TS-11 added the second:
   *
   *  1. Through a `member`-subject REPORT about them. This was the only path,
   *     and it is why every sanction recorded without a report was unappealable
   *     in practice however loudly the Code of Conduct said otherwise.
   *  2. Through `mod_audit_logs.target_user_id` naming them directly. This is
   *     what makes wave 2's community bans (`community_ban_applied`, written
   *     report-less by `community-governance-log.service.ts` with the barred
   *     member in `target_user_id`) and the direct admin restriction from the
   *     member drawer appealable at all. Backed by
   *     `IDX_mod_audit_logs_target_created_at`.
   *
   * Two entry points, both covering both ways:
   *  - `actionId` supplied — the member deep-linked a specific action. Accepted
   *    only if that action is about THEM, by either route (ownership scoping).
   *    A mismatch is a 403, never a silent re-resolve, because the member asked
   *    to appeal a specific thing.
   *  - no `actionId` — the common locked-out case. Takes the most recent
   *    appealable action against them, whichever route it came by.
   *
   * Returns `null` when nothing resolvable is found (a cold appeal): the appeal
   * still stands, unlinked, rather than being rejected on a lookup miss, and
   * `submitAppeal` deliberately applies no filing deadline to it.
   */
  private async resolveAppealTarget(
    appellantUserId: string,
    actionId?: string,
  ): Promise<{
    actionId: string;
    reportId: string | null;
    severity: ReportSeverity;
    /** When the appealed decision was TAKEN. Starts the 14-day filing clock. */
    actionAt: Date;
    /** The community the decision came out of, as a slug, when there is one. */
    community: string | null;
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
      // The audit row is theirs if it is linked to a report about them OR it
      // names them directly. Either is proof enough that they are appealing a
      // decision made about themselves.
      const isTargetedAtMember = log?.targetUserId === appellantUserId;
      if (!log || (!report && !isTargetedAtMember)) {
        throw new ForbiddenException(
          'That moderation action is not one you can appeal.',
        );
      }
      return this.describeAppealTarget(log, report ?? null);
    }

    // The two candidate sets, read in parallel and reconciled by recency: a
    // member may hold both a report-backed sanction and a report-less one (a
    // platform warning last month, a community ban yesterday), and the appeal
    // should land on whichever actually happened last.
    const [latestByReport, latestByTarget] = await Promise.all([
      reportsById.size
        ? this.auditLogs.findOne({
            where: {
              reportId: In([...reportsById.keys()]),
              action: In(APPEALABLE_ACTIONS),
            },
            order: { createdAt: 'DESC' },
          })
        : Promise.resolve(null),
      this.auditLogs.findOne({
        where: {
          targetUserId: appellantUserId,
          action: In(APPEALABLE_ACTIONS),
        },
        order: { createdAt: 'DESC' },
      }),
    ]);

    const candidates = [latestByReport, latestByTarget].filter(
      (log): log is ModAuditLog => log !== null,
    );
    if (!candidates.length) return null;
    const latestAction = candidates.reduce((newest, log) =>
      log.createdAt.getTime() > newest.createdAt.getTime() ? log : newest,
    );

    const report = latestAction.reportId
      ? (reportsById.get(latestAction.reportId) ?? null)
      : null;
    return this.describeAppealTarget(latestAction, report);
  }

  /**
   * Fills in the queue context for one resolved audit row.
   *
   * `severity` comes from the report when there is one. A report-less sanction
   * has no severity of its own, so it takes `Medium` — the entity's own default
   * — rather than an invented one. A community ban is not automatically an
   * emergency, and treating it as one would push it to the top of a queue
   * ordered by exactly that field.
   */
  private async describeAppealTarget(
    log: ModAuditLog,
    report: Report | null,
  ): Promise<{
    actionId: string;
    reportId: string | null;
    severity: ReportSeverity;
    actionAt: Date;
    community: string | null;
  }> {
    const community = report
      ? await this.communitySlugForAppealReport(report)
      : await this.communitySlugForCommunityBan(log);
    return {
      actionId: log.id,
      reportId: report ? report.id : null,
      severity: report ? report.severity : ReportSeverity.Medium,
      actionAt: log.createdAt,
      community,
    };
  }

  /**
   * The community a report-backed appeal belongs to.
   *
   * A `community`-subject report carries the slug in `subjectId` itself, which
   * is the same short-circuit `toModReportDTO` takes; everything else goes
   * through the shared subject resolver.
   */
  private async communitySlugForAppealReport(
    report: Report,
  ): Promise<string | null> {
    if (report.subjectType === ReportSubjectType.Community) {
      return report.subjectId;
    }
    return this.communitySlugForReport(report);
  }

  /**
   * The community behind a report-less community ban.
   *
   * Wave 2's `community_ban_applied` audit row is deliberately report-less and
   * carries no community id of its own (see `handoff-B2`), so the only way back
   * to the room is the ban itself. Read through the shared `DataSource` with a
   * parameterized statement rather than by importing `CommunitiesModule`, for
   * exactly the reason `ReportSubjectResolverService` gives: the module graph
   * already has `CommunitiesModule -> ContentModerationModule <- this module`,
   * and reaching the other way would close a real cycle.
   *
   * Most recent ban wins, matching what the handoff recommends for a member
   * barred from more than one community. Returns `null` for any other action,
   * and for a ban that has since been deleted: an appeal with no community is
   * the state the column was in before TS-11 and is handled everywhere.
   */
  private async communitySlugForCommunityBan(
    log: ModAuditLog,
  ): Promise<string | null> {
    if (
      log.action !== COMMUNITY_BAN_AUDIT_ACTION ||
      !log.targetUserId ||
      !UUID_RE.test(log.targetUserId)
    ) {
      return null;
    }
    const rows = await this.dataSource.query<{ slug: string }[]>(
      `SELECT c.slug AS "slug"
         FROM community_bans b
         JOIN communities c ON c.id = b.community_id
        WHERE b.user_id = $1
        ORDER BY b.created_at DESC
        LIMIT 1`,
      [log.targetUserId],
    );
    return rows[0]?.slug ?? null;
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

    // Conflict-of-interest guard (COM-10): the moderator who made the ORIGINAL
    // decision being appealed may not also decide the appeal — that lets them
    // uphold their own call unchecked, which is exactly what an appeal process
    // exists to prevent. Blocks outright (409, same family as the
    // already-decided guard) rather than merely flagging: every other guard in
    // this method (the awaiting-status check, the conditional `update` race
    // guard) already blocks rather than warns, and a moderator who cannot
    // review their own case has no legitimate reason to see a "review anyway"
    // path. Silent when the appeal has no resolvable `actionId` (a cold
    // appeal) — there is no original decision to compare against.
    if (appeal.actionId) {
      const originalAction = await this.auditLogs.findOne({
        where: { id: appeal.actionId },
      });
      if (originalAction?.actorId === actorId) {
        throw new ForbiddenException(
          'You made the original decision being appealed and cannot review this appeal.',
        );
      }
    }

    const decidedStatus =
      dto.decision === 'uphold' ? AppealStatus.Upheld : AppealStatus.Overturned;
    const decision = dto.note ?? dto.decision;
    const decidedAtInstant = new Date();

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
        // TS-11: `decided_at` is written in the SAME conditional update that
        // claims the decision, so the timestamp and the status can never
        // disagree. §05 promises a decision inside 7 days; before this column
        // there was no way to tell whether that had happened, so the promise
        // could be neither reported on nor missed visibly.
        { status: decidedStatus, decision, decidedAt: decidedAtInstant },
      );
      if (updateResult.affected !== 1) {
        throw new ConflictException('Appeal has already been decided');
      }

      // An overturned appeal that leaves the sanction in place is the same
      // class of bug as a sanction that never applied: a moderation decision
      // that does not take effect. Undo it as part of the same decision.
      if (dto.decision === 'overturn') {
        await this.revertOriginalAction(manager, appeal, actorId);
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
      appeal.decidedAt = decidedAtInstant;
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

  /**
   * Undoes the sanction an OVERTURNED appeal was filed against, branching on
   * the original audit row's action (`appeal.actionId`).
   *
   * Appeals are accepted for every `APPEALABLE_ACTIONS` code, but an overturn
   * used to call `restoreSuspensionForAppeal` and nothing else — which only
   * flips a `Suspended` account back to `Active` (BE-COM-08). So a member
   * whose post was hidden and who WON their appeal still had the post hidden,
   * and a restricted member who won still could not post until the timer
   * lapsed; admin saw "overturned" while nothing had changed for the member.
   * `ContentModerationService.revert` was written for exactly this and had
   * zero callers.
   *
   *  - `hide_content` / `remove_content` -> drop the `content_moderation` row
   *    for the report's subject, restoring the content to fully visible, and
   *    record a `content_restored` audit entry.
   *  - `restrict` -> clear `users.restricted` / `restrictedUntil` on the
   *    reported member (the flags `NotRestrictedGuard` reads), and record a
   *    `restriction_lifted` entry. Deliberately does NOT touch `status`: a
   *    restriction never changed it (see
   *    `AccountEnforcementService.enforceAgainstUser`).
   *  - `suspend` / `ban`, `warn`, or a cold appeal with no resolvable original
   *    action -> the pre-existing account-restore path, which is a silent
   *    no-op when the member is not actually suspended.
   *
   * Runs inside `reviewAppeal`'s transaction, so the reversal, the appeal's
   * new status and the `appeal_overturned` audit row commit together.
   */
  private async revertOriginalAction(
    manager: EntityManager,
    appeal: Appeal,
    actorId: string,
  ): Promise<void> {
    const originalAction = appeal.actionId
      ? await manager.findOne(ModAuditLog, { where: { id: appeal.actionId } })
      : null;
    const action = originalAction?.action ?? null;
    const report = appeal.reportId
      ? await manager.findOne(Report, { where: { id: appeal.reportId } })
      : null;

    if (report && (action === 'hide_content' || action === 'remove_content')) {
      await this.contentModeration.revert(
        manager,
        report.subjectType,
        report.subjectId,
      );
      await this.audit.writeAuditLog(
        appeal.reportId,
        actorId,
        'content_restored',
        undefined,
        undefined,
        undefined,
        manager,
      );
      return;
    }

    if (action === 'restrict') {
      const profile = report
        ? await this.accountEnforcement.resolveReportedProfile(report)
        : null;
      if (profile) {
        await manager.update(
          User,
          { id: profile.userId },
          { restricted: false, restrictedUntil: null },
        );
        await this.audit.writeAuditLog(
          appeal.reportId,
          actorId,
          'restriction_lifted',
          undefined,
          undefined,
          undefined,
          manager,
        );
      }
      return;
    }

    await this.accountEnforcement.restoreSuspensionForAppeal(
      manager,
      appeal.reportId,
    );

    // TS-12. An overturned appeal has to close the door the pending hold left
    // open. Without this a member could win their appeal on Tuesday and still
    // be permanently banned on Wednesday, by a second moderator ratifying a
    // hold nobody had told about the overturn. Runs inside the same transaction
    // as the overturn, so the two commit together or not at all.
    if (appeal.appellantId) {
      await this.banRatification.withdrawPendingHold(
        manager,
        appeal.appellantId,
      );
    }
  }

  /**
   * GET /mod/ratifications — the permanent bans waiting on a second moderator
   * (TS-12). Delegates to {@link BanRatificationService}.
   */
  listRatifications(
    status?: BanRatificationStatus,
  ): Promise<BanRatificationDTO[]> {
    return this.banRatification.list(status);
  }

  /**
   * PATCH /mod/ratifications/:id — confirm or refuse another moderator's
   * permanent ban. Delegates to {@link BanRatificationService}, which enforces
   * that the ratifier is not the moderator who asked (including when that
   * moderator is an admin).
   */
  decideRatification(
    id: string,
    actorId: string,
    actorRole: string,
    dto: RatifyBanDto,
  ): Promise<BanRatificationDTO> {
    return this.banRatification.decide(id, actorId, actorRole, dto);
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

  /**
   * PATCH /mod/reports/:id/assignment — claim or release a report (COM-5).
   *
   * Assignment is a claim, not a free-for-all: it used to write
   * `assignedModeratorId = assign ? actorId : null` unconditionally, so any
   * moderator could silently take over or drop a report another moderator was
   * already working (BE-COM-32). Now:
   *
   *   - claiming a report someone else holds is a 409 (Admins may take over),
   *   - releasing a report is only allowed for its current holder (Admins may
   *     release anyone's),
   *   - re-claiming a report you already hold stays an idempotent no-op 200.
   *
   * The write is a conditional `UPDATE ... WHERE assigned_moderator_id IS [NOT]
   * DISTINCT FROM :expected` (the same race-safe claim shape
   * `triageJoinRequest` uses), so two moderators clicking "claim" at the same
   * instant cannot both win: the loser's update affects no row and gets the
   * 409 rather than quietly overwriting the winner.
   *
   * Still no audit-log row: claiming/releasing is workflow bookkeeping, not a
   * moderation decision — the immutable trail stays reserved for actions that
   * change a report's outcome.
   */
  async setAssignment(
    id: string,
    actorId: string,
    actorRole: string,
    assign: boolean,
  ): Promise<ModReportDTO> {
    const report = await this.findReportOrThrow(id);
    const currentAssignee = report.assignedModeratorId;
    // `actorRole` is a JWT claim, typed `string` on `CurrentUserData` — the
    // widening says so, rather than implying the two are the same enum.
    const isAdmin = actorRole === (UserRole.Admin as string);

    if (assign) {
      if (currentAssignee === actorId) {
        return this.toRow(report);
      }
      if (currentAssignee !== null && !isAdmin) {
        throw new ConflictException(
          'That report is already assigned to another moderator.',
        );
      }
    } else {
      if (currentAssignee === null) {
        return this.toRow(report);
      }
      if (currentAssignee !== actorId && !isAdmin) {
        throw new ForbiddenException(
          'Only the assigned moderator can release that report.',
        );
      }
    }

    const result = await this.reports
      .createQueryBuilder()
      .update(Report)
      .set({
        assignedModeratorId: assign ? actorId : null,
        assignedAt: assign ? new Date() : null,
      })
      .where('id = :id', { id })
      // `IS NOT DISTINCT FROM` rather than `=`: the expected value is NULL on
      // an unclaimed report, and `NULL = NULL` is NULL, not true.
      .andWhere('assigned_moderator_id IS NOT DISTINCT FROM :expected', {
        expected: currentAssignee,
      })
      .execute();

    if (!result.affected) {
      throw new ConflictException(
        'That report’s assignment changed while you were acting on it. Reload and try again.',
      );
    }

    return this.toRow(await this.findReportOrThrow(id));
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

  /**
   * Narrows the queue to one community, by slug (TS-14).
   *
   * `reports` carries no community foreign key, so attribution is the
   * `(subjectType, subjectId)` pair — the exact rules
   * `admin-communities/community-report-scope.ts` documents, reused here rather
   * than re-invented:
   *
   *  - a `community` report: `subjectId` IS the slug.
   *  - a `post` or `reply` report: `subjectId` is a content id, resolved
   *    through `community_posts` / `community_post_replies`.
   *  - an `event` report: `subjectId` is the gathering's slug, and a gathering
   *    hosted inside a community carries `community_id`.
   *  - `member`, `message` and `venue` reports have no community and are
   *    excluded rather than guessed at, matching that file exactly.
   *
   * The slug resolves inside the statement, so an unknown slug makes every
   * content arm compare against NULL (never true) while the `community`-subject
   * arm still matches: a report filed against a community that has since been
   * deleted is still a report about that slug.
   *
   * The uuid columns are compared as `::text` against the `varchar`
   * `subject_id` so a slug or the `"unspecified"` sentinel sitting in that
   * column can never make Postgres throw "invalid input syntax for type uuid" —
   * the same hazard `UUID_RE` guards on the entity side.
   */
  private applyCommunityFilter(
    qb: SelectQueryBuilder<Report>,
    communitySlug: string,
  ): void {
    qb.andWhere(
      `(
        (r.subjectType = :communitySubjectType AND r.subjectId = :communitySlug)
        OR (r.subjectType = :postSubjectType AND EXISTS (
              SELECT 1 FROM community_posts cp
              WHERE cp.id::text = r.subject_id
                AND cp.community_id = (SELECT co.id FROM communities co WHERE co.slug = :communitySlug)))
        OR (r.subjectType = :replySubjectType AND EXISTS (
              SELECT 1 FROM community_post_replies cpr
              JOIN community_posts cpp ON cpp.id = cpr.post_id
              WHERE cpr.id::text = r.subject_id
                AND cpp.community_id = (SELECT co.id FROM communities co WHERE co.slug = :communitySlug)))
        OR (r.subjectType = :eventSubjectType AND EXISTS (
              SELECT 1 FROM events ev
              WHERE ev.slug = r.subject_id
                AND ev.community_id = (SELECT co.id FROM communities co WHERE co.slug = :communitySlug)))
      )`,
      {
        communitySubjectType: ReportSubjectType.Community,
        postSubjectType: ReportSubjectType.Post,
        replySubjectType: ReportSubjectType.Reply,
        eventSubjectType: ReportSubjectType.Event,
        communitySlug,
      },
    );
  }

  /**
   * TS-06: narrows the queue to reports that are part of a SURGE — several
   * different people reporting the same subject.
   *
   * A pile-on is the highest-volume event the queue will ever see and the one
   * where the right action is most often against the reporters, and the flat
   * list showed it as thirty unrelated complaints with thirty SLA clocks. This
   * filter is the moderator asking "show me only the piles".
   *
   * The predicate is a grouped semi-join on `(subject_type, subject_id)` over
   * every UNRESOLVED report, with the same two thresholds
   * `CommunityAutoFreezeService.isReportPileUp` uses (see the constants at the
   * top of this file). A reporter with no account counts as their own distinct
   * person via the `COALESCE(..., 'anon:' || id)` trick that file established,
   * so a wave of account-less reports is still visible as a wave rather than
   * collapsing to one.
   */
  private applySurgeFilter(qb: SelectQueryBuilder<Report>): void {
    qb.andWhere(
      `(r.subject_type, r.subject_id) IN (
        SELECT sibling.subject_type, sibling.subject_id
        FROM reports sibling
        WHERE sibling.status IN (:...surgeOpenStatuses)
        GROUP BY sibling.subject_type, sibling.subject_id
        HAVING COUNT(*) >= :surgeMinOpen
          AND COUNT(DISTINCT COALESCE(sibling.reporter_id::text, 'anon:' || sibling.id::text)) >= :surgeMinReporters
      )`,
      {
        surgeOpenStatuses: [ReportStatus.Open, ReportStatus.Escalated],
        surgeMinOpen: SURGE_MIN_OPEN_REPORTS,
        surgeMinReporters: SURGE_MIN_DISTINCT_REPORTERS,
      },
    );
  }

  /**
   * TS-06: the piles behind the rows on one page.
   *
   * Grouped over EVERY unresolved report about the page's subjects, never over
   * the page itself: the whole point is that twenty-nine of the thirty reports
   * are somewhere the moderator cannot see. One statement for the page, so
   * this costs a single extra query whatever the page size.
   *
   * A pair with exactly one open report gets no cluster at all: its own row
   * already says everything a cluster would, and a queue where every row wears
   * a "1 report" badge teaches a moderator to stop reading badges.
   *
   * `subject_type` and `subject_id` are matched with two separate `ANY(...)`
   * lists rather than a tuple list, so both stay index-friendly. That is
   * slightly wider than the page (it admits a same-id-different-type pair that
   * cannot actually happen, since every subject id is a uuid or a slug from
   * one domain), so the result is narrowed back to the page's real pairs in
   * TypeScript before anything is returned.
   */
  private async clustersFor(reports: Report[]): Promise<ModReportClusterDTO[]> {
    if (!reports.length) return [];

    const subjectTypes = [
      ...new Set(reports.map((report) => report.subjectType)),
    ];
    const subjectIds = [...new Set(reports.map((report) => report.subjectId))];
    const pageKeys = new Set(
      reports.map((report) => `${report.subjectType}\u0000${report.subjectId}`),
    );

    // `CLUSTER_ID_CAP` is a module constant, never client input, so it is
    // spliced into the array slice rather than bound (Postgres will not take a
    // parameter as a subscript bound here).
    const rows = await this.dataSource.query<ClusterAggregateRow[]>(
      `SELECT subject_type AS "subjectType",
              subject_id AS "subjectId",
              COUNT(*)::int AS "openCount",
              COUNT(DISTINCT COALESCE(reporter_id::text, 'anon:' || id::text))::int AS "distinctReporterCount",
              COUNT(*) FILTER (WHERE sla_due_at < now())::int AS "overdueCount",
              MIN(CASE severity::text
                    WHEN 'emergency' THEN 0
                    WHEN 'high' THEN 1
                    WHEN 'medium' THEN 2
                    ELSE 3
                  END)::int AS "severityRank",
              MIN(created_at) AS "firstReportedAt",
              MAX(created_at) AS "lastReportedAt",
              (array_agg(id::text ORDER BY created_at ASC, id ASC))[1:${CLUSTER_ID_CAP}] AS "reportIds"
         FROM reports
        WHERE subject_type = ANY($1::reports_subject_type_enum[])
          AND subject_id = ANY($2::varchar[])
          AND status = ANY($3::reports_status_enum[])
        GROUP BY subject_type, subject_id
       HAVING COUNT(*) > 1`,
      [subjectTypes, subjectIds, [ReportStatus.Open, ReportStatus.Escalated]],
    );

    return rows
      .filter((row) => pageKeys.has(`${row.subjectType}\u0000${row.subjectId}`))
      .map((row) => ({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        openCount: row.openCount,
        distinctReporterCount: row.distinctReporterCount,
        overdueCount: row.overdueCount,
        highestSeverity: SEVERITY_RANK[row.severityRank] ?? ReportSeverity.Low,
        firstReportedAt: new Date(row.firstReportedAt).toISOString(),
        lastReportedAt: new Date(row.lastReportedAt).toISOString(),
        isSurge:
          row.openCount >= SURGE_MIN_OPEN_REPORTS &&
          row.distinctReporterCount >= SURGE_MIN_DISTINCT_REPORTERS,
        reportIds: row.reportIds ?? [],
      }))
      .sort(
        (left, right) =>
          right.distinctReporterCount - left.distinctReporterCount ||
          right.openCount - left.openCount,
      );
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

  // `hasFullReportVisibility` defaults to `true` for every caller EXCEPT
  // `actOnReport`'s community-mod carve-out (see `assertCanActOnReport`):
  // `list`/`getById`/`setAssignment` all sit behind the class-level platform
  // `@Roles(Moderator, Admin)` guard, so they never need to pass `false`.
  // When it is `false`, the reporter/reported blocks are replaced with the
  // same withheld shapes the anonymous-reporter case already uses (mirrors
  // `ModReporterDTO`'s `{ anonymous: true }` arm) instead of the fully
  // resolved name, real-name-bearing profile, and platform-wide prior-report
  // counts `describeReporter`/`describeReported` would otherwise return —
  // and the assigned-moderator id/name are withheld the same way.
  private async toRow(
    report: Report,
    withDetail = false,
    hasFullReportVisibility = true,
  ): Promise<ModReportDTO> {
    const [
      reporter,
      reported,
      assignedModeratorName,
      resolutionActorName,
      communitySlug,
    ] = await Promise.all([
      hasFullReportVisibility
        ? this.describeReporter(report)
        : Promise.resolve<ModReporterDTO>({ anonymous: true }),
      hasFullReportVisibility
        ? this.describeReported(report)
        : Promise.resolve<ModReportedDTO>({
            id: report.subjectId,
            handle: report.subjectId,
            priorReports: 0,
          }),
      hasFullReportVisibility && report.assignedModeratorId
        ? this.audit.nameForUserId(report.assignedModeratorId)
        : undefined,
      report.resolvedAt
        ? this.audit.nameForUserId(report.resolutionActorId)
        : undefined,
      // TS-14: which community this report came from. A community mod acting
      // through the carve-out already knows which community they moderate, and
      // the redacted response withholds everything else about the report, so
      // this is resolved only for the full-visibility path.
      hasFullReportVisibility
        ? this.communitySlugForReport(report)
        : Promise.resolve(null),
    ]);
    const detail =
      withDetail && hasFullReportVisibility
        ? await this.buildDetail(report, reporter, reported)
        : undefined;
    const resolution = resolutionActorName
      ? toResolutionDTO(report, resolutionActorName)
      : undefined;
    return toModReportDTO(
      report,
      reporter,
      reported,
      detail,
      assignedModeratorName,
      resolution,
      hasFullReportVisibility,
      communitySlug,
    );
  }

  /**
   * The slug of the community ONE report came from, or `null`.
   *
   * A `community`-subject report needs no lookup at all (`toModReportDTO`
   * short-circuits on `subjectId`, which is already the slug). Everything else
   * goes through the shared subject resolver and then one id -> slug lookup,
   * which is what `toRows` does in bulk for a whole page.
   */
  private async communitySlugForReport(report: Report): Promise<string | null> {
    if (report.subjectType === ReportSubjectType.Community) return null;
    const { communityId } = await this.subjectResolver.resolve(report);
    if (!communityId) return null;
    return this.communityMembership.slugById(communityId);
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

    // Assigned-moderator names (COM-5) and resolution-actor names (COM-7)
    // share one batched lookup — both resolve through the exact same
    // "moderator id -> display name" rule.
    const moderatorIds = [
      ...reports
        .filter((report) => report.assignedModeratorId)
        .map((report) => report.assignedModeratorId as string),
      ...reports
        .filter((report) => report.resolvedAt && report.resolutionActorId)
        .map((report) => report.resolutionActorId as string),
    ];

    const [
      reporterNames,
      reportedProfiles,
      priorReportCounts,
      moderatorNames,
      reporterCredibility,
      communitySlugs,
    ] = await Promise.all([
      this.audit.namesForUserIds(reporterUserIds),
      this.resolveReportedProfiles(reports),
      this.priorReportCountsBySubject(reports),
      this.audit.namesForUserIds(moderatorIds),
      this.reporterCredibilityByReporterId(reports),
      this.communitySlugsByReportId(reports),
    ]);

    return reports.map((report) => {
      const reporter = this.buildReporter(
        report,
        reporterNames,
        reporterCredibility,
      );
      const reported = this.buildReported(
        report,
        reportedProfiles,
        priorReportCounts,
      );
      const assignedModeratorName = report.assignedModeratorId
        ? this.audit.resolveActorName(
            report.assignedModeratorId,
            moderatorNames,
          )
        : undefined;
      const resolution = report.resolvedAt
        ? toResolutionDTO(
            report,
            this.audit.resolveActorName(
              report.resolutionActorId,
              moderatorNames,
            ),
          )
        : undefined;
      return toModReportDTO(
        report,
        reporter,
        reported,
        undefined,
        assignedModeratorName,
        resolution,
        true,
        communitySlugs.get(report.id) ?? null,
      );
    });
  }

  /**
   * TS-14: the community every report on a page came from, keyed by report id.
   *
   * Community context is the triage signal a moderator most wants and the queue
   * had none of: `ModReportDTO.community` was populated only when the subject
   * was literally a community, so a post, reply or gathering report — most of
   * the queue — showed nothing. Two queries for a whole page: the shared
   * subject resolver batches the content lookups, then one `refsByIds` turns
   * the community ids into the slugs the rows display.
   *
   * A `member` or `message` report resolves to `null` here, deliberately. That
   * is the same line `admin-communities/community-report-scope.ts` draws: a DM
   * belongs to no community, and a member belongs to many, so naming one would
   * be a guess dressed as a fact.
   */
  private async communitySlugsByReportId(
    reports: Report[],
  ): Promise<Map<string, string>> {
    const slugsByReportId = new Map<string, string>();

    // A `community`-subject report already carries its slug as `subjectId`;
    // `toModReportDTO` reads it straight off the row, so it needs no lookup.
    const resolvable = reports.filter(
      (report) => report.subjectType !== ReportSubjectType.Community,
    );
    if (!resolvable.length) return slugsByReportId;

    const resolutions = await this.subjectResolver.resolveMany(resolvable);
    const communityIds = [
      ...new Set(
        [...resolutions.values()]
          .map((resolution) => resolution.communityId)
          .filter((communityId): communityId is string => communityId != null),
      ),
    ];
    if (!communityIds.length) return slugsByReportId;

    const refs = await this.communityMembership.refsByIds(communityIds);
    for (const [reportId, resolution] of resolutions) {
      if (!resolution.communityId) continue;
      const ref = refs.get(resolution.communityId);
      if (ref) slugsByReportId.set(reportId, ref.slug);
    }
    return slugsByReportId;
  }

  // Sync twin of `describeReporter` fed from a pre-resolved name map — the
  // anonymization arms are identical: anonymous and erased reporters stay
  // `{ anonymous: true }` and are never named.
  private buildReporter(
    report: Report,
    reporterNames: Map<string, string>,
    reporterCredibility: Map<
      string,
      { priorReports: number; priorDismissed: number }
    >,
  ): ModReporterDTO {
    if (report.anonymous) return { anonymous: true };
    if (!report.reporterId) return { anonymous: true };
    const aggregate = reporterCredibility.get(report.reporterId) ?? {
      priorReports: 0,
      priorDismissed: 0,
    };
    // Subtract the current report from its own totals when it is itself
    // already resolved (mirrors `buildReported`'s subtract-self trick) — an
    // open/escalated current report never entered the aggregate to begin
    // with, so there is nothing to subtract for it.
    const isSelfResolved = Boolean(report.resolvedAt);
    const priorReports = Math.max(
      0,
      aggregate.priorReports - (isSelfResolved ? 1 : 0),
    );
    const priorDismissed = Math.max(
      0,
      aggregate.priorDismissed -
        (isSelfResolved && report.resolutionAction === 'dismiss' ? 1 : 0),
    );
    return {
      anonymous: false,
      id: report.reporterId,
      name: reporterNames.get(report.reporterId) ?? 'Member',
      priorReports,
      priorDismissed,
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

  /**
   * ADM-22: batched twin of `priorReportCountsBySubject`, but `GROUP BY
   * reporterId` over each reporter's PAST RESOLVED reports across the page —
   * an open/escalated report has no verdict yet, so it carries no
   * credibility signal either way. `total` is every resolved report the
   * reporter has filed; `dismissed` is the subset that resolved to
   * `dismiss` (the unfounded outcome). Deliberately a raw count pair rather
   * than a derived score/tier a moderator can't audit.
   *
   * `buildReporter` subtracts the current report from both counts when the
   * current report is itself already resolved, mirroring
   * `priorReportCountsBySubject`/`buildReported`'s subtract-self trick.
   */
  private async reporterCredibilityByReporterId(
    reports: Report[],
  ): Promise<Map<string, { priorReports: number; priorDismissed: number }>> {
    const credibilityByReporterId = new Map<
      string,
      { priorReports: number; priorDismissed: number }
    >();

    const reporterIds = [
      ...new Set(
        reports
          .filter((report) => !report.anonymous && report.reporterId)
          .map((report) => report.reporterId as string),
      ),
    ];
    if (!reporterIds.length) return credibilityByReporterId;

    const rows = await this.reports
      .createQueryBuilder('r')
      .select('r.reporterId', 'reporterId')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        `COUNT(*) FILTER (WHERE r.resolutionAction = 'dismiss')`,
        'dismissed',
      )
      .where('r.reporterId IN (:...reporterIds)', { reporterIds })
      .andWhere('r.resolvedAt IS NOT NULL')
      .groupBy('r.reporterId')
      .getRawMany<{ reporterId: string; total: string; dismissed: string }>();

    for (const row of rows) {
      credibilityByReporterId.set(row.reporterId, {
        priorReports: Number(row.total),
        priorDismissed: Number(row.dismissed),
      });
    }
    return credibilityByReporterId;
  }

  private async describeReporter(report: Report): Promise<ModReporterDTO> {
    if (report.anonymous) return { anonymous: true };
    // An erased reporter (`reporter_id` NULLed by the erasure sweep) becomes
    // indistinguishable from an anonymous one — which is exactly right: the
    // report stands, the person behind it is no longer identifiable. Reusing
    // the existing `{ anonymous: true }` arm keeps `ModReporterDTO.id`
    // honestly non-nullable instead of inventing a placeholder id.
    if (!report.reporterId) return { anonymous: true };
    // ADM-22: reporter credibility, counted over this reporter's PAST
    // RESOLVED reports only (excluding the current one) — an open report has
    // no verdict yet. `priorDismissed` is filtered by `resolutionAction`
    // alone since that column is only ever set on a resolved report.
    const [name, priorReports, priorDismissed] = await Promise.all([
      this.audit.nameForUserId(report.reporterId),
      this.reports.count({
        where: {
          reporterId: report.reporterId,
          id: Not(report.id),
          resolvedAt: Not(IsNull()),
        },
      }),
      this.reports.count({
        where: {
          reporterId: report.reporterId,
          id: Not(report.id),
          resolutionAction: 'dismiss',
        },
      }),
    ]);
    return {
      anonymous: false,
      id: report.reporterId,
      name,
      priorReports,
      priorDismissed,
    };
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

    // What was actually reported, resolved from the subject itself. The drawer
    // used to show only the reporter's own free text under "excerpt", so a
    // moderator judging a post read the complaint about it and never the post.
    // Degrades to the reporter's text when the subject has no readable body
    // (a member, a venue), which is what it always showed.
    const subject = await this.subjectResolver.resolve(report);
    const contentAuthorHandle = subject.authorUserId
      ? await this.handleForUserId(subject.authorUserId)
      : null;

    return {
      contentAuthor: contentAuthorHandle ?? reported.handle,
      excerpt: subject.excerpt ?? report.detail ?? '',
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
      // Surface the raw evidence array (P0.9) so a moderator sees client-attached
      // evidence AND the server snapshot (message/housing) on the drawer.
      ...(report.evidence && report.evidence.length
        ? { evidence: report.evidence }
        : {}),
    };
  }

  /**
   * A member's public handle (their profile slug), for the drawer's
   * "content author" line. `null` for an id with no profile row, so the caller
   * falls back to what it showed before rather than printing a bare uuid.
   */
  private async handleForUserId(userId: string): Promise<string | null> {
    const profile = await this.profiles.findOne({
      where: { userId },
      select: { slug: true },
    });
    return profile?.slug ?? null;
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
    // When the disputer filed ANONYMOUSLY, this off-account email is an
    // identifying detail: the detail view already stamps "Reporter identity
    // withheld." for an anonymous report, so surfacing their contact email
    // alongside it would contradict that promise and deanonymize a reporter who
    // trusted "anonymous" to mean fully shielded. Suppress it for an anonymous
    // report; a NON-anonymous dispute still exposes it so a moderator can reach a
    // disputer with no account.
    const contactEmail =
      !report.anonymous && report.contactEmail
        ? report.contactEmail
        : undefined;

    return {
      ...(disputeReason ? { disputeReason } : {}),
      ...(listingEvidence ? { listingEvidence } : {}),
      ...(contactEmail ? { contactEmail } : {}),
    };
  }

  private async toAppealRow(
    appeal: Appeal,
    now: Date = new Date(),
  ): Promise<AppealDTO> {
    const [appellant, original] = await Promise.all([
      this.describeAppellant(appeal),
      this.describeOriginalAction(appeal),
    ]);
    return toAppealDTO(appeal, appellant, original, now);
  }

  /**
   * Batched equivalent of `toAppealRow` for a whole page — same output, same
   * order, in a bounded number of queries instead of ~3 per appeal.
   *
   * Appellant profiles resolve in one `In([...])` lookup, the appealed audit
   * rows in one more, and every one of those rows' actor names in a single
   * `namesForUserIds` — so a page is three queries regardless of size.
   */
  private async toAppealRows(
    appeals: Appeal[],
    // Passed in rather than read per row so every appeal on a page is judged
    // overdue against the SAME instant. Reading `new Date()` inside the map
    // would let a slow page straddle a due date.
    now: Date = new Date(),
  ): Promise<AppealDTO[]> {
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
      return toAppealDTO(appeal, appellant, original, now);
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
