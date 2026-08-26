/**
 * =============================================================================
 * MODERATOR WORKLOAD, IN ONE PASS (TS-04)
 * =============================================================================
 *
 * WHAT "WORKLOAD" MEANS HERE. Not how many actions a moderator took, and not
 * how fast anyone is. It is a property of the QUEUES, never of the people:
 * for each queue a moderator actually works, how much is waiting, how long the
 * oldest thing has waited, and how many items are already past the window the
 * platform published for them. Those three numbers, per queue, are the whole
 * model. `activeModeratorCount` rides alongside so "eleven open reports" can be
 * read as "eleven each" or "eleven between six of us", which are different
 * situations with the same depth.
 *
 * Deliberately NOT here: per-moderator throughput, actions-per-hour, any
 * leaderboard. This platform is volunteer-run, moderator burnout is the failure
 * mode this exists to catch, and a system that measures individuals to fix
 * burnout causes it. The queue is the unit.
 *
 * WHY THE THRESHOLDS ARE WHAT THEY ARE. They live in
 * `moderation-queue-thresholds.ts` with a paragraph of reasoning each, and
 * nothing else in the codebase may hard-code one. In short: every
 * `oldestHours.critical` is read off that queue's own published review window
 * (`join-request-sla.ts`, `appeal-window.ts`, `verification-sla.ts`) rather
 * than invented here, so the alert fires exactly when a published promise
 * breaks; the warning level sits inside the window, because a warning is only
 * useful while there is still time to act on it; and the depth levels are
 * pitched at what a volunteer rota can actually clear, which on a platform this
 * size means low numbers on purpose.
 *
 * TWO HALVES OF ONE ALERTING STORY.
 *
 *   - THE MACHINE HALF is `/metrics`. Every number below is written to the
 *     Prometheus gauges `moderation_queue_depth`,
 *     `moderation_queue_overdue`, `moderation_queue_oldest_item_age_seconds`
 *     and `moderation_active_moderators` (see `MetricsService`), labelled by
 *     queue. That is what a real alerting consumer in front of `/metrics`
 *     (LB-05) will page on, with its own rules and its own escalation.
 *   - THE IN-APP HALF is `ModerationQueueAlertService`, an hourly cron that
 *     turns a threshold crossing into a notification in the bell of every
 *     moderator and admin.
 *
 * The in-app half exists because QueerPulse delivers NO email and never will:
 * there is no mailer in this codebase and none is coming, so "alerting" can
 * only mean the bell plus the scrape endpoint. Nothing here may be described
 * anywhere as sending a message off-platform.
 *
 * QUERY BUDGET. One aggregate per queue, computed in SQL with `COUNT(*)
 * FILTER (...)` and `MIN(created_at)` so a queue of ten thousand rows costs
 * the same as a queue of ten and nothing is dragged through the Node heap.
 * Never a query per row. Plus one response-time query and one moderator count,
 * run in two concurrency waves (the `AdminOverviewService` precedent) so a
 * dashboard load never queues seven statements against `DATABASE_POOL_MAX` at
 * once.
 *
 * STAFF ONLY. Every read of this service is behind
 * `AdminModerationHealthController`'s moderator/admin gate or behind the cron.
 * There is no member-facing surface for any of it, and there must never be
 * one: queue depth is an operational fact about the people doing the work.
 *
 * -----------------------------------------------------------------------
 * THE COLUMNS THIS FILE DEPENDS ON, AND WHY THEY CANNOT SILENTLY ROT
 * -----------------------------------------------------------------------
 * The aggregates below are SQL fragments (`COUNT(*) FILTER (...)`), so the
 * columns inside them are not reachable by the TypeScript compiler. A rename
 * in another module would compile clean here and then fail at runtime inside
 * an hourly cron that catches its own errors, which means the alert would
 * simply stop firing and nobody would be told. That is the worst possible
 * failure mode for an alerting component.
 *
 * So every column name is resolved from TypeORM ENTITY METADATA in the
 * constructor by {@link resolveColumnName}, which THROWS when a property is
 * missing. Nest builds its providers at boot, so a rename fails the deploy
 * loudly instead of quietly disarming the alert. The properties depended on,
 * for anyone grepping after a rename:
 *
 *   PlatformJoinRequest   createdAt, dueAt, assignedStaffId, status,
 *                         reviewedAt
 *   Report                createdAt, slaDueAt, assignedModeratorId, status
 *   Appeal                createdAt, slaDueAt, status
 *   VerificationRequest   createdAt, dueAt, assignedStaffId, status
 *   BanRatification       createdAt, expiresAt, status
 *
 * `status` is not listed in the resolver because it is addressed through the
 * query builder's own property path rather than a raw fragment; the rest are.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository } from 'typeorm';
import { medianHours } from '../admin-overview/admin-overview-response';
import { MetricsService } from '../metrics/metrics.service';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from '../membership/entities/join-request.entity';
import { Appeal, AppealStatus } from '../moderation/entities/appeal.entity';
import {
  BanRatification,
  BanRatificationStatus,
} from '../moderation/entities/ban-ratification.entity';
import { Report, ReportStatus } from '../reports/entities/report.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { VerificationRequestStatus } from '../verification/verification-request-status';
import {
  ModerationQueueHealthDTO,
  ModerationQueueMeasurement,
  toModerationQueueHealthDTO,
} from './moderation-queue-health-response';
import {
  MODERATION_QUEUE_RESPONSE_WINDOW_MS,
  ModerationQueueKey,
} from './moderation-queue-thresholds';

const HOUR_MS = 60 * 60 * 1000;

/**
 * One aggregate row as Postgres returns it. Counts come back as `bigint`,
 * which the pg driver hands over as a STRING (a bigint does not fit a JS
 * number safely, so the driver refuses to guess), hence the string types and
 * the `toCount` parser below rather than a bare `+row.depth`.
 */
interface RawQueueAggregate {
  depth: string | null;
  overdueCount: string | null;
  unassignedCount: string | null;
  oldestCreatedAt: Date | string | null;
}

/** One decided row's arrival-to-decision delta, as `EXTRACT(EPOCH ...)` numeric. */
interface RawResponseDelta {
  hours: string | number | null;
}

function toCount(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The physical column name behind an entity property, or a loud failure.
 *
 * Called only from the constructor, so a property that no longer exists takes
 * the BOOT down with a message naming the entity and the property. That is the
 * whole point: the alternative is a `undefined` spliced into a SQL string and
 * a syntax error raised once an hour inside a handler that logs and moves on.
 */
function resolveColumnName<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  property: string,
): string {
  const column = repository.metadata.findColumnWithPropertyName(property);
  if (!column) {
    throw new Error(
      `ModerationQueueHealthService: ${repository.metadata.name} has no property ` +
        `"${property}". A rename broke the moderation queue health aggregates; ` +
        'update this service to match.',
    );
  }
  return column.databaseName;
}

/** Hours between `from` and `now`, or `null` when there is no `from`. */
function hoursSince(from: Date | string | null, now: Date): number | null {
  if (from === null) return null;
  const at = from instanceof Date ? from : new Date(from);
  const elapsedMs = now.getTime() - at.getTime();
  if (!Number.isFinite(elapsedMs)) return null;
  // A clock skew that puts the oldest row in the future reads as 0 rather than
  // as a negative age, which no threshold band could mean anything about.
  return Math.max(elapsedMs, 0) / HOUR_MS;
}

@Injectable()
export class ModerationQueueHealthService {
  /**
   * Every physical column name the SQL fragments below splice in, resolved
   * once from entity metadata at construction. Nest constructs providers at
   * boot, so a property renamed in another module fails the deploy here rather
   * than disarming the hourly alert in silence. See the file header.
   */
  private readonly columns: {
    joinRequest: {
      createdAt: string;
      dueAt: string;
      assignedStaffId: string;
      reviewedAt: string;
    };
    report: {
      createdAt: string;
      slaDueAt: string;
      assignedModeratorId: string;
    };
    appeal: { createdAt: string; slaDueAt: string };
    verificationRequest: {
      createdAt: string;
      dueAt: string;
      assignedStaffId: string;
    };
    banRatification: { createdAt: string; expiresAt: string };
  };

  constructor(
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
    @InjectRepository(Appeal)
    private readonly appeals: Repository<Appeal>,
    @InjectRepository(VerificationRequest)
    private readonly verificationRequests: Repository<VerificationRequest>,
    @InjectRepository(BanRatification)
    private readonly banRatifications: Repository<BanRatification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly metrics: MetricsService,
  ) {
    this.columns = {
      joinRequest: {
        createdAt: resolveColumnName(this.joinRequests, 'createdAt'),
        dueAt: resolveColumnName(this.joinRequests, 'dueAt'),
        assignedStaffId: resolveColumnName(
          this.joinRequests,
          'assignedStaffId',
        ),
        reviewedAt: resolveColumnName(this.joinRequests, 'reviewedAt'),
      },
      report: {
        createdAt: resolveColumnName(this.reports, 'createdAt'),
        slaDueAt: resolveColumnName(this.reports, 'slaDueAt'),
        assignedModeratorId: resolveColumnName(
          this.reports,
          'assignedModeratorId',
        ),
      },
      appeal: {
        createdAt: resolveColumnName(this.appeals, 'createdAt'),
        slaDueAt: resolveColumnName(this.appeals, 'slaDueAt'),
      },
      verificationRequest: {
        createdAt: resolveColumnName(this.verificationRequests, 'createdAt'),
        dueAt: resolveColumnName(this.verificationRequests, 'dueAt'),
        assignedStaffId: resolveColumnName(
          this.verificationRequests,
          'assignedStaffId',
        ),
      },
      banRatification: {
        createdAt: resolveColumnName(this.banRatifications, 'createdAt'),
        expiresAt: resolveColumnName(this.banRatifications, 'expiresAt'),
      },
    };
  }

  /**
   * The whole workload picture, and the only entry point: the admin read and
   * the hourly alert cron both call this, so the console and the bell can
   * never disagree about a number.
   *
   * Writing the Prometheus gauges is done HERE rather than from a scrape-time
   * `collect()` callback (the shape `database_pool_connections` uses) because
   * these numbers cost seven database queries: a `collect()` callback would
   * run all seven on every 15-second scrape forever. Pushing on each
   * computation instead means the gauges are refreshed by the hourly cron and
   * again whenever a human opens the console. That is recent enough for a
   * queue measured in hours, and free.
   */
  async getQueueHealth(): Promise<ModerationQueueHealthDTO> {
    const now = new Date();
    const responseWindowStart = new Date(
      now.getTime() - MODERATION_QUEUE_RESPONSE_WINDOW_MS,
    );

    // Wave 1: one aggregate per queue. Five statements, none dependent on any
    // other, capped at the same concurrency `SearchService.MAX_CONCURRENT_
    // QUERIES` and `AdminOverviewService` settled on.
    const [
      inviteRequestAggregate,
      reportAggregate,
      appealAggregate,
      verificationAggregate,
      banRatificationAggregate,
    ] = await Promise.all([
      this.aggregateInviteRequests(now),
      this.aggregateReports(now),
      this.aggregateAppeals(now),
      this.aggregateVerificationRequests(now),
      this.aggregateBanRatifications(now),
    ]);

    // Wave 2: the two figures that are not per-queue aggregates.
    const [inviteRequestMedianHours, activeModeratorCount] = await Promise.all([
      this.inviteRequestMedianResponseHours(responseWindowStart),
      this.countActiveModerators(),
    ]);

    const measurements: ModerationQueueMeasurement[] = [
      {
        queue: ModerationQueueKey.InviteRequests,
        depth: toCount(inviteRequestAggregate.depth),
        overdueCount: toCount(inviteRequestAggregate.overdueCount),
        unassignedCount: toCount(inviteRequestAggregate.unassignedCount),
        oldestItemHours: hoursSince(
          inviteRequestAggregate.oldestCreatedAt,
          now,
        ),
        medianResponseHours: inviteRequestMedianHours,
      },
      {
        queue: ModerationQueueKey.Reports,
        depth: toCount(reportAggregate.depth),
        overdueCount: toCount(reportAggregate.overdueCount),
        unassignedCount: toCount(reportAggregate.unassignedCount),
        oldestItemHours: hoursSince(reportAggregate.oldestCreatedAt, now),
        // The reports median is published by the admin overview dashboard
        // (`stats.medianResponseHours`), computed there from the
        // `mod_audit_logs` row that actually closed each report out over a
        // 90-day window. Recomputing it here from `reports.resolved_at` over a
        // different window would put two different numbers under the same
        // words on two admin screens. One number, one owner.
        medianResponseHours: null,
      },
      {
        queue: ModerationQueueKey.Appeals,
        depth: toCount(appealAggregate.depth),
        overdueCount: toCount(appealAggregate.overdueCount),
        // `appeals` carries no assignment column: an appeal is picked up by
        // whoever decides it, and there is no claim step to be unclaimed from.
        unassignedCount: null,
        oldestItemHours: hoursSince(appealAggregate.oldestCreatedAt, now),
        medianResponseHours: null,
      },
      {
        queue: ModerationQueueKey.Verification,
        depth: toCount(verificationAggregate.depth),
        overdueCount: toCount(verificationAggregate.overdueCount),
        unassignedCount: toCount(verificationAggregate.unassignedCount),
        oldestItemHours: hoursSince(verificationAggregate.oldestCreatedAt, now),
        medianResponseHours: null,
      },
      {
        queue: ModerationQueueKey.BanRatifications,
        depth: toCount(banRatificationAggregate.depth),
        overdueCount: toCount(banRatificationAggregate.overdueCount),
        // No assignment column either, and deliberately: a ratification is by
        // definition worked by whichever moderator is NOT the one who asked
        // for it, so pre-claiming one would be the wrong affordance.
        unassignedCount: null,
        oldestItemHours: hoursSince(
          banRatificationAggregate.oldestCreatedAt,
          now,
        ),
        medianResponseHours: null,
      },
    ];

    const health = toModerationQueueHealthDTO(
      measurements,
      activeModeratorCount,
      now,
    );
    this.metrics.recordModerationQueueHealth(health);
    return health;
  }

  /**
   * Invite requests a reviewer can still act on: `pending` AND `waitlisted`.
   *
   * WAITLISTED COUNTS. `JoinRequestsService.decideJoinRequest` names the two
   * together as "both open states a review can act on", `setAssignment` lets a
   * moderator claim either, and `due_at` is stamped once at submission and
   * never cleared by waitlisting, so the platform's own three-day clock is
   * still running on a waitlisted applicant. Counting only `pending` would
   * report thirty three-week-old waitlisted requests as an empty, healthy
   * queue while thirty published promises sat broken. The full argument, and
   * what would have to change for the opposite reading, is on
   * `ModerationQueueKey.InviteRequests`.
   *
   * Overdue is measured against `due_at`, the stored promise `joinRequestDueAt`
   * wrote at submit time, never a window recomputed here, so this and the
   * admin queue's own overdue badge can never disagree. A NULL `due_at` (rows
   * that predate the column) is "no clock", never overdue: the
   * `QueueAssignmentColumns` doc is explicit about that and every read path has
   * to honour it.
   *
   * Index-backed by `IDX_join_requests_status_created_at` (`status`,
   * `created_at`), which serves both the status filter and the
   * `MIN(created_at)`.
   */
  private aggregateInviteRequests(now: Date): Promise<RawQueueAggregate> {
    const column = this.columns.joinRequest;
    return this.rawAggregate(
      this.joinRequests
        .createQueryBuilder('joinRequest')
        .select('COUNT(*)', 'depth')
        .addSelect(
          `COUNT(*) FILTER (WHERE "joinRequest"."${column.dueAt}" IS NOT NULL AND "joinRequest"."${column.dueAt}" < :now)`,
          'overdueCount',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "joinRequest"."${column.assignedStaffId}" IS NULL)`,
          'unassignedCount',
        )
        .addSelect(
          `MIN("joinRequest"."${column.createdAt}")`,
          'oldestCreatedAt',
        )
        .where('joinRequest.status IN (:...openStatuses)', {
          openStatuses: [
            PlatformJoinRequestStatus.Pending,
            PlatformJoinRequestStatus.Waitlisted,
          ],
        })
        .setParameter('now', now),
    );
  }

  /**
   * Reports still `open` or `escalated`, the same two statuses the admin
   * overview counts as open, so the two dashboards agree on "how many open
   * reports are there".
   *
   * Overdue is `sla_due_at`, the severity-derived clock `report-severity.ts`
   * stamps at filing (one hour for outing/doxxing), so an emergency counts as
   * overdue an hour after it lands while a low-severity report does not.
   * Index-backed by `IDX_reports_status`.
   */
  private aggregateReports(now: Date): Promise<RawQueueAggregate> {
    const column = this.columns.report;
    return this.rawAggregate(
      this.reports
        .createQueryBuilder('report')
        .select('COUNT(*)', 'depth')
        .addSelect(
          `COUNT(*) FILTER (WHERE "report"."${column.slaDueAt}" < :now)`,
          'overdueCount',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "report"."${column.assignedModeratorId}" IS NULL)`,
          'unassignedCount',
        )
        .addSelect(`MIN("report"."${column.createdAt}")`, 'oldestCreatedAt')
        .where('report.status IN (:...openStatuses)', {
          openStatuses: [ReportStatus.Open, ReportStatus.Escalated],
        })
        .setParameter('now', now),
    );
  }

  /**
   * Appeals still `awaiting`. Overdue is `sla_due_at`, the seven-day window
   * `AddAppealDecisionWindows` backfilled onto every row, which is why this
   * column is NOT NULL and needs no null guard.
   * Index-backed by `IDX_appeals_status`.
   */
  private aggregateAppeals(now: Date): Promise<RawQueueAggregate> {
    const column = this.columns.appeal;
    return this.rawAggregate(
      this.appeals
        .createQueryBuilder('appeal')
        .select('COUNT(*)', 'depth')
        .addSelect(
          `COUNT(*) FILTER (WHERE "appeal"."${column.slaDueAt}" < :now)`,
          'overdueCount',
        )
        // Selected as an explicit NULL rather than omitted, so every queue's
        // aggregate has the same column list and `RawQueueAggregate` stays one
        // shape. This table carries no assignment column to count.
        .addSelect('NULL::bigint', 'unassignedCount')
        .addSelect(`MIN("appeal"."${column.createdAt}")`, 'oldestCreatedAt')
        .where('appeal.status = :awaiting', {
          awaiting: AppealStatus.Awaiting,
        })
        .setParameter('now', now),
    );
  }

  /**
   * Verification requests in any state a moderator still has to act on:
   * `pending` (nobody has picked it up), `in_review` (somebody has, and it is
   * still their problem) and `appealing` (a rejected request back for a second
   * look). `in_review` counts as waiting on purpose: a request parked in
   * review for a week is exactly the kind of stall a depth-only reading of
   * `pending` would hide.
   *
   * Index-backed by the entity's `(status, type)` index.
   */
  private aggregateVerificationRequests(now: Date): Promise<RawQueueAggregate> {
    const column = this.columns.verificationRequest;
    return this.rawAggregate(
      this.verificationRequests
        .createQueryBuilder('verificationRequest')
        .select('COUNT(*)', 'depth')
        .addSelect(
          `COUNT(*) FILTER (WHERE "verificationRequest"."${column.dueAt}" IS NOT NULL AND "verificationRequest"."${column.dueAt}" < :now)`,
          'overdueCount',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE "verificationRequest"."${column.assignedStaffId}" IS NULL)`,
          'unassignedCount',
        )
        .addSelect(
          `MIN("verificationRequest"."${column.createdAt}")`,
          'oldestCreatedAt',
        )
        .where('verificationRequest.status IN (:...openStatuses)', {
          openStatuses: [
            VerificationRequestStatus.Pending,
            VerificationRequestStatus.InReview,
            VerificationRequestStatus.Appealing,
          ],
        })
        .setParameter('now', now),
    );
  }

  /**
   * Permanent bans waiting on their second signature. Overdue here means
   * something different from the other four queues: a row still `pending`
   * after `expires_at` means the lapse sweep has not run, and a member is
   * being held under an interim suspension past the hold's own expiry. See
   * the ban-ratification band in `moderation-queue-thresholds.ts`.
   *
   * Index-backed by `IDX_ban_ratifications_status_expires_at`.
   */
  private aggregateBanRatifications(now: Date): Promise<RawQueueAggregate> {
    const column = this.columns.banRatification;
    return this.rawAggregate(
      this.banRatifications
        .createQueryBuilder('banRatification')
        .select('COUNT(*)', 'depth')
        .addSelect(
          `COUNT(*) FILTER (WHERE "banRatification"."${column.expiresAt}" < :now)`,
          'overdueCount',
        )
        // Selected as an explicit NULL rather than omitted, so every queue's
        // aggregate has the same column list and `RawQueueAggregate` stays one
        // shape. This table carries no assignment column to count.
        .addSelect('NULL::bigint', 'unassignedCount')
        .addSelect(
          `MIN("banRatification"."${column.createdAt}")`,
          'oldestCreatedAt',
        )
        .where('banRatification.status = :pending', {
          pending: BanRatificationStatus.Pending,
        })
        .setParameter('now', now),
    );
  }

  /**
   * How long the invite queue has actually been taking, as a median over
   * decisions inside the response window.
   *
   * `medianHours` is imported from `admin-overview-response.ts` rather than
   * reimplemented (in SQL or otherwise): the platform already has one
   * definition of "the median of a set of elapsed hours", including how it
   * treats an even-sized set and an empty one, and a second definition is a
   * second answer waiting to disagree.
   *
   * One query, and it returns only the elapsed-hours numbers, never rows.
   * Bounded by the window rather than by all of history, the same constraint
   * `AdminOverviewService.loadReportResolutions` documents at length.
   * Index-backed by `IDX_join_requests_reviewed_at`, added alongside this
   * feature precisely so this filter is not a sequential scan on an admin path
   * an hourly cron also walks.
   */
  private async inviteRequestMedianResponseHours(
    windowStart: Date,
  ): Promise<number | null> {
    const column = this.columns.joinRequest;
    const rows = await this.joinRequests
      .createQueryBuilder('joinRequest')
      .select(
        `EXTRACT(EPOCH FROM ("joinRequest"."${column.reviewedAt}" - "joinRequest"."${column.createdAt}")) / 3600`,
        'hours',
      )
      .where('joinRequest.reviewedAt >= :windowStart', { windowStart })
      .getRawMany<RawResponseDelta>();
    const deltas = rows
      .map((row) => Number(row.hours ?? Number.NaN))
      .filter((hours) => Number.isFinite(hours));
    return medianHours(deltas);
  }

  /**
   * The people who can work these queues: active accounts on the platform
   * `moderator` or `admin` tier.
   *
   * Additive staff GRANTS (`staff-roles.registry.ts`) are deliberately not
   * counted. No grant opens any of the five queues above (invites, join
   * requests, identity verification, member bans and the report queue are all
   * named in that registry as surfaces no grant ever opens), so a platform
   * with twelve grant holders and one moderator has one moderator, and this
   * number has to say so.
   */
  private countActiveModerators(): Promise<number> {
    return this.users.count({
      where: {
        role: In([UserRole.Moderator, UserRole.Admin]),
        status: UserStatus.Active,
      },
    });
  }

  /**
   * Runs an aggregate builder and normalises the "no rows at all" case.
   *
   * A grouped-less `COUNT(*)` always returns one row, so the fallback below is
   * belt-and-braces for a mocked repository in a spec rather than a case
   * Postgres can produce.
   */
  private async rawAggregate(builder: {
    getRawOne: () => Promise<RawQueueAggregate | undefined>;
  }): Promise<RawQueueAggregate> {
    const row = await builder.getRawOne();
    return (
      row ?? {
        depth: '0',
        overdueCount: '0',
        unassignedCount: '0',
        oldestCreatedAt: null,
      }
    );
  }
}
