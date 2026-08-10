import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import {
  JoinRequest,
  JoinRequestStatus,
} from '../membership/entities/join-request.entity';
import { Appeal, AppealStatus } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { MOD_ACTION_CODES } from '../moderation/dto/mod-action.dto';
import { statusForAction } from '../moderation/mod-action-status';
import {
  Report,
  ReportSeverity,
  ReportStatus,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  AdminOverviewDTO,
  bucketResponseTimes,
  medianHours,
  reasonCodeToCategoryIndex,
} from './admin-overview-response';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** `reportsByType.weeks` is always this many weekly buckets, oldest first —
 *  mirrors `AdminCommunitiesService`'s `SPARKLINE_WEEK_COUNT` precedent of a
 *  fixed, zero-filled window rather than a short array. */
const REPORTS_BY_TYPE_WEEK_COUNT = 8;

/** `memberGrowth.points` window: "~10 weekly points" per the task brief. */
const MEMBER_GROWTH_WEEK_COUNT = 10;

/** How many of each feed source's most recent rows are pulled before the
 *  merged, cross-source list is sorted and trimmed to `FEED_RESULT_LIMIT`. */
const FEED_SOURCE_FETCH_LIMIT = 10;

/** How many merged feed rows the dashboard actually renders. */
const FEED_RESULT_LIMIT = 6;

/** Resolution window for `loadReportResolutions`: only resolutions that
 *  happened within this many days back are considered. Bounds the id lists
 *  handed to `In(...)` by recent-resolution volume rather than by the entire
 *  all-time resolved-report history — see the method's doc for why. */
const REPORT_RESOLUTION_WINDOW_DAYS = 90;

// The subset of `MOD_ACTION_CODES` that `statusForAction` (the same mapper
// `ModerationService.actOnReport` uses to write `Report.status`) resolves to
// `ReportStatus.Resolved` — i.e. every action except `escalate`. A
// `ModAuditLog` row with one of these actions is the row that actually closed
// a report out, and is what "resolution time" is measured against. Derived
// from the real mapping rather than hand-duplicated (unlike the `GOOD_/BAD_
// MODERATION_ACTIONS` vocab in `admin-members.service.ts`) because the
// resolving/non-resolving split has to stay exactly in sync with
// `statusForAction` or a report could be "resolved" by this service's
// reckoning while `actOnReport` disagrees.
const REPORT_RESOLVING_ACTIONS = new Set<string>(
  MOD_ACTION_CODES.filter(
    (action) => statusForAction(action) === ReportStatus.Resolved,
  ),
);

/** One `Report` closed out by a moderator action, with the timestamps needed
 *  to compute how long it took. */
interface ReportResolutionRow {
  reportId: string;
  reportCreatedAt: Date;
  resolvedAt: Date;
  actorId: string | null;
}

/** A candidate row for the merged activity feed, before actor/target userIds
 *  are resolved to display names and the cross-source list is sorted/capped. */
interface FeedCandidate {
  id: string;
  type: string;
  actorUserId: string | null;
  /** Set only for actors that are not resolvable via `MemberLookup` (e.g. a
   *  `JoinRequest` applicant, who has no account/profile yet) — takes
   *  priority over `actorUserId` when present, including when explicitly
   *  `null` (an anonymous/erased actor). */
  actorNameOverride?: string | null;
  targetUserId: string | null;
  community: string | null;
  count: number | null;
  atMs: number;
  route: string;
}

/**
 * Read model behind the admin dashboard overview: platform-wide stats, the
 * "needs a human" triage counts, the reports-by-type and member-growth
 * charts, the response-time distribution, and the merged activity feed.
 *
 * Every aggregate is computed with one batched query per metric — never one
 * query per row — mirroring `AdminCommunitiesService`'s grouped-query
 * pattern. `ModerationService.computeCounts()` is NOT reused here: this
 * service needs the emergency/non-emergency split and the oldest-open-report
 * age that `computeCounts()` doesn't expose, and getting those still requires
 * fetching the open reports directly — injecting `ModerationService` on top
 * of that would just be a second, redundant path to the same repository.
 */
@Injectable()
export class AdminOverviewService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(JoinRequest)
    private readonly joinRequests: Repository<JoinRequest>,
    @InjectRepository(Appeal) private readonly appeals: Repository<Appeal>,
    @InjectRepository(ModAuditLog)
    private readonly modAuditLogs: Repository<ModAuditLog>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly usersService: UsersService,
  ) {}

  async getOverview(): Promise<AdminOverviewDTO> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
    const reportsByTypeWindowStart = new Date(
      now.getTime() - REPORTS_BY_TYPE_WEEK_COUNT * WEEK_MS,
    );
    const memberGrowthWindowStart = new Date(
      now.getTime() - MEMBER_GROWTH_WEEK_COUNT * WEEK_MS,
    );

    // 14 independent queries, run in 3 waves of at most 5 concurrent queries
    // (mirroring `SearchService.MAX_CONCURRENT_QUERIES`) rather than one
    // 14-way `Promise.all`, which would queue against `DATABASE_POOL_MAX`
    // (default 10) on its own and starve every other concurrent request.
    // None of these queries depend on one another, so the wave boundaries
    // below are purely about pool pressure, not sequencing.
    const [
      activeMembersCount,
      verifiedMembersCount,
      netNewThisMonthCount,
      profilesForMemberGrowth,
      openReportRows,
    ] = await Promise.all([
      this.usersService.countActiveMembers(),
      this.profiles.count({ where: { verified: true } }),
      this.profiles.count({
        where: { joinedAt: MoreThanOrEqual(thirtyDaysAgo) },
      }),
      this.profiles.find({
        select: ['joinedAt'],
        where: { joinedAt: MoreThanOrEqual(memberGrowthWindowStart) },
      }),
      // Ascending so `openReportRows[0]` (if any) is the oldest open report —
      // exactly what `oldestOpenHours` needs, with no separate MIN() query.
      this.reports.find({
        where: { status: In([ReportStatus.Open, ReportStatus.Escalated]) },
        select: ['severity', 'createdAt'],
        order: { createdAt: 'ASC' },
      }),
    ]);

    const [
      reportRowsForReportsByType,
      recentReportsForFeed,
      reportResolutions,
      pendingJoinRequestsCount,
      openAppealsCount,
    ] = await Promise.all([
      this.reports.find({
        where: { createdAt: MoreThanOrEqual(reportsByTypeWindowStart) },
        select: ['reasonCode', 'createdAt'],
      }),
      this.reports.find({
        select: ['id', 'severity', 'anonymous', 'reporterId', 'createdAt'],
        order: { createdAt: 'DESC' },
        take: FEED_SOURCE_FETCH_LIMIT,
      }),
      this.loadReportResolutions(),
      this.joinRequests.count({
        where: { status: JoinRequestStatus.Pending },
      }),
      this.appeals.count({ where: { status: AppealStatus.Awaiting } }),
    ]);

    const [
      recentProfilesForFeed,
      recentVouchesForFeed,
      recentCommunityMembersForFeed,
      recentJoinRequestsForFeed,
    ] = await Promise.all([
      this.profiles.find({
        select: ['userId', 'firstName', 'lastName', 'joinedAt'],
        order: { joinedAt: 'DESC' },
        take: FEED_SOURCE_FETCH_LIMIT,
      }),
      this.vouches.find({
        where: { withdrawnAt: IsNull() },
        order: { createdAt: 'DESC' },
        take: FEED_SOURCE_FETCH_LIMIT,
      }),
      this.communityMembers.find({
        order: { joinedAt: 'DESC' },
        take: FEED_SOURCE_FETCH_LIMIT,
      }),
      this.joinRequests.find({
        order: { createdAt: 'DESC' },
        take: FEED_SOURCE_FETCH_LIMIT,
      }),
    ]);

    // --- stats.activeMembers / verifiedMembers ---
    // Growth of the active-member base over the trailing 30 days: the members
    // who joined this month, as a percentage of the base that existed at the
    // window's start (current total minus this month's joiners). This is
    // positive whenever members were added, so its sign always agrees with the
    // "+N this month" foot count the tile shows alongside it. Null when there's
    // no prior base to grow from (base <= 0 — e.g. every active member joined
    // within the window), which the tile renders as "not enough data yet".
    const priorMonthBaseCount = activeMembersCount - netNewThisMonthCount;
    const growthPercent =
      priorMonthBaseCount > 0
        ? Math.round((netNewThisMonthCount / priorMonthBaseCount) * 100)
        : null;

    // --- stats.openReports / triage ---
    // `triage.openReports` and `stats.openReports.value` are deliberately the
    // SAME total-open count (not "open minus emergencies") — the simplest of
    // the two consistent readings the task brief allows, and the one that
    // keeps the stat tile and the triage row agreeing on "how many open
    // reports are there" without the reader having to know they're disjoint.
    const openReportsCount = openReportRows.length;
    const emergenciesCount = openReportRows.filter(
      (openReport) => openReport.severity === ReportSeverity.Emergency,
    ).length;
    const oldestOpenHours = openReportRows[0]
      ? (now.getTime() - openReportRows[0].createdAt.getTime()) / HOUR_MS
      : null;

    // --- responseTime / stats.medianResponseHours ---
    const reportResolutionDeltaHours = reportResolutions.map(
      (resolution) =>
        (resolution.resolvedAt.getTime() -
          resolution.reportCreatedAt.getTime()) /
        HOUR_MS,
    );
    const medianResponseHours = medianHours(reportResolutionDeltaHours);
    const responseTime = reportResolutionDeltaHours.length
      ? {
          medianHours: medianResponseHours,
          buckets: bucketResponseTimes(reportResolutionDeltaHours),
        }
      : null;

    // --- reportsByType ---
    const reportsByTypeBuckets = this.buildEmptyWeeklyBuckets<
      [number, number, number, number]
    >(now, REPORTS_BY_TYPE_WEEK_COUNT, () => [0, 0, 0, 0]);
    for (const reportRow of reportRowsForReportsByType) {
      const bucketIndex = this.weekBucketIndex(
        now,
        reportRow.createdAt,
        REPORTS_BY_TYPE_WEEK_COUNT,
      );
      if (bucketIndex === null) continue;
      const categoryIndex = reasonCodeToCategoryIndex(reportRow.reasonCode);
      const bucket = reportsByTypeBuckets[bucketIndex];
      if (bucket === undefined) continue;
      bucket.value[categoryIndex] = (bucket.value[categoryIndex] ?? 0) + 1;
    }
    const reportsByTypeWeeks = reportsByTypeBuckets.map((bucket) => ({
      weekStart: new Date(bucket.weekStartMs).toISOString(),
      values: bucket.value,
    }));

    // --- memberGrowth ---
    const memberGrowthBuckets = this.buildEmptyWeeklyBuckets<number>(
      now,
      MEMBER_GROWTH_WEEK_COUNT,
      () => 0,
    );
    for (const profileRow of profilesForMemberGrowth) {
      const bucketIndex = this.weekBucketIndex(
        now,
        profileRow.joinedAt,
        MEMBER_GROWTH_WEEK_COUNT,
      );
      if (bucketIndex === null) continue;
      const bucket = memberGrowthBuckets[bucketIndex];
      if (bucket === undefined) continue;
      bucket.value += 1;
    }
    let spikeBucketIndex = 0;
    for (
      let bucketIndex = 1;
      bucketIndex < memberGrowthBuckets.length;
      bucketIndex += 1
    ) {
      const candidateBucket = memberGrowthBuckets[bucketIndex];
      const currentSpikeBucket = memberGrowthBuckets[spikeBucketIndex];
      if (
        candidateBucket !== undefined &&
        currentSpikeBucket !== undefined &&
        candidateBucket.value > currentSpikeBucket.value
      ) {
        spikeBucketIndex = bucketIndex;
      }
    }
    const hasAnyMemberGrowth = memberGrowthBuckets.some(
      (bucket) => bucket.value > 0,
    );
    const memberGrowthPoints = memberGrowthBuckets.map((bucket, index) => ({
      at: new Date(bucket.weekStartMs).toISOString(),
      joined: bucket.value,
      churned: null,
      spike: hasAnyMemberGrowth && index === spikeBucketIndex,
    }));

    // --- feed ---
    const feed = await this.assembleFeed({
      recentReportsForFeed,
      reportResolutions,
      recentProfilesForFeed,
      recentVouchesForFeed,
      recentCommunityMembersForFeed,
      recentJoinRequestsForFeed,
    });

    return {
      stats: {
        activeMembers: {
          value: activeMembersCount,
          growthPercent,
          netNewThisMonth: netNewThisMonthCount,
        },
        openReports: {
          value: openReportsCount,
          oldestOpenHours,
          emergencies: emergenciesCount,
        },
        medianResponseHours,
        sustainerMrr: null,
        sustainerCount: null,
        verifiedMembers: verifiedMembersCount,
      },
      triage: {
        emergencies: emergenciesCount,
        openReports: openReportsCount,
        pendingVerifications: pendingJoinRequestsCount,
        openAppeals: openAppealsCount,
      },
      reportsByType: { weeks: reportsByTypeWeeks },
      memberGrowth: { points: memberGrowthPoints },
      responseTime,
      feed,
    };
  }

  /**
   * Every `Resolved` report paired with the `ModAuditLog` row that actually
   * closed it out — the row against that `reportId` whose `action` is one of
   * `REPORT_RESOLVING_ACTIONS`, latest by `createdAt` when more than one such
   * row exists (a report could in principle be acted on more than once
   * before landing on `Resolved`) — restricted to resolutions within the last
   * `REPORT_RESOLUTION_WINDOW_DAYS` days.
   *
   * The window is what keeps this bounded. The previous shape fetched EVERY
   * resolved report, then passed all of their ids to
   * `modAuditLogs.find({ reportId: In([...]) })`; past ~65535 ids Postgres
   * rejects the bind-parameter list outright (`bind message has 65535
   * parameter formats but N parameters`), and it dragged the entire
   * resolved-report history through the Node heap on every dashboard load —
   * the exact constraint documented on
   * `AdminCommunitiesService.loadReportScope`. Following that precedent, the
   * recent set is fetched FIRST — here the resolving audit rows inside the
   * window — and only the report ids they reference are resolved, so both
   * `In(...)` lists are bounded by recent-resolution volume, never all-time
   * volume.
   *
   * Windowing on the audit row's `createdAt` (which IS the resolution instant)
   * bounds the DATA without changing the metric's DEFINITION: "median time to
   * resolve a report" is unchanged, now measured over resolutions that
   * happened in the window (a recent-window reading of the same measure — and
   * the only resolutions the activity feed would ever surface anyway). A
   * report filed long ago but slowly resolved inside the window is still
   * counted, so slow resolutions are not silently dropped from the median.
   *
   * Two batched queries total, never one per report.
   */
  private async loadReportResolutions(): Promise<ReportResolutionRow[]> {
    const resolutionWindowStart = new Date(
      Date.now() - REPORT_RESOLUTION_WINDOW_DAYS * DAY_MS,
    );

    // Ascending order means the last write seen per reportId is the latest —
    // exactly the "if multiple, take the latest resolution row" rule, with no
    // separate sort/group step needed. `reportId` non-null is enforced in SQL
    // so the `In(...)` below is fed only real report ids.
    const resolvingAuditRows = await this.modAuditLogs.find({
      where: {
        action: In([...REPORT_RESOLVING_ACTIONS]),
        reportId: Not(IsNull()),
        createdAt: MoreThanOrEqual(resolutionWindowStart),
      },
      order: { createdAt: 'ASC' },
    });
    if (!resolvingAuditRows.length) return [];

    const latestResolvingAuditRowByReportId = new Map<string, ModAuditLog>();
    for (const auditRow of resolvingAuditRows) {
      if (!auditRow.reportId) continue;
      latestResolvingAuditRowByReportId.set(auditRow.reportId, auditRow);
    }

    // Confirm each referenced report is actually `Resolved` (an audit row with
    // a resolving action but a report since re-opened/superseded contributes
    // no delta). `In(...)` here is bounded by the windowed audit-row count.
    const resolvedReports = await this.reports.find({
      where: {
        id: In([...latestResolvingAuditRowByReportId.keys()]),
        status: ReportStatus.Resolved,
      },
      select: ['id', 'createdAt'],
    });

    const resolutions: ReportResolutionRow[] = [];
    for (const resolvedReport of resolvedReports) {
      const resolvingAuditRow = latestResolvingAuditRowByReportId.get(
        resolvedReport.id,
      );
      // No matching audit row is a data gap (every real resolution writes
      // one) rather than something to fabricate a timestamp for — that
      // report simply contributes no delta to the response-time metrics.
      if (!resolvingAuditRow) continue;
      resolutions.push({
        reportId: resolvedReport.id,
        reportCreatedAt: resolvedReport.createdAt,
        resolvedAt: resolvingAuditRow.createdAt,
        actorId: resolvingAuditRow.actorId,
      });
    }
    return resolutions;
  }

  /**
   * Merges the per-source feed candidates, resolves every actor/target
   * userId to a display name in ONE batched `MemberLookup` call, then sorts
   * the combined list newest-first and caps it at `FEED_RESULT_LIMIT`.
   *
   * Sources included: report filings, report resolutions (via
   * `loadReportResolutions`), new members, vouches, community joins, and
   * join-request submissions. `Event` (hosted events) is deliberately
   * excluded — see the service-level doc / task report for why.
   */
  private async assembleFeed(input: {
    recentReportsForFeed: Pick<
      Report,
      'id' | 'severity' | 'anonymous' | 'reporterId' | 'createdAt'
    >[];
    reportResolutions: ReportResolutionRow[];
    recentProfilesForFeed: Pick<
      Profile,
      'userId' | 'firstName' | 'lastName' | 'joinedAt'
    >[];
    recentVouchesForFeed: Vouch[];
    recentCommunityMembersForFeed: CommunityMember[];
    recentJoinRequestsForFeed: JoinRequest[];
  }): Promise<AdminOverviewDTO['feed']> {
    const feedCandidates: FeedCandidate[] = [];

    for (const report of input.recentReportsForFeed) {
      feedCandidates.push({
        id: `report-filed-${report.id}`,
        type: 'report_filed',
        // An anonymous report hides the reporter even when `reporterId` is
        // still on the row (mirrors `ModerationService.describeReporter`);
        // a null `reporterId` (erasure) reads the same way either way.
        actorUserId: report.anonymous ? null : report.reporterId,
        targetUserId: null,
        community: null,
        count: null,
        atMs: report.createdAt.getTime(),
        route:
          report.severity === ReportSeverity.Emergency
            ? '/admin/moderation?tab=emergencies'
            : '/admin/moderation',
      });
    }

    const recentResolutionsForFeed = [...input.reportResolutions]
      .sort(
        (first, second) =>
          second.resolvedAt.getTime() - first.resolvedAt.getTime(),
      )
      .slice(0, FEED_SOURCE_FETCH_LIMIT);
    for (const resolution of recentResolutionsForFeed) {
      feedCandidates.push({
        id: `report-resolved-${resolution.reportId}`,
        type: 'report_resolved',
        // The moderator who closed it out; `null` is the erased-actor case
        // (`ModAuditLog.actorId`'s doc), read the same way as any other
        // anonymous/erased actor.
        actorUserId: resolution.actorId,
        targetUserId: null,
        community: null,
        count: null,
        atMs: resolution.resolvedAt.getTime(),
        route: '/admin/moderation',
      });
    }

    for (const profile of input.recentProfilesForFeed) {
      feedCandidates.push({
        id: `member-joined-${profile.userId}`,
        type: 'member_joined',
        actorUserId: null,
        // Already have the name on hand from this same row — no need to
        // round-trip it through `MemberLookup`.
        actorNameOverride: `${profile.firstName} ${profile.lastName}`.trim(),
        targetUserId: null,
        community: null,
        count: null,
        atMs: profile.joinedAt.getTime(),
        route: '/admin/members',
      });
    }

    for (const vouch of input.recentVouchesForFeed) {
      feedCandidates.push({
        id: `vouch-${vouch.id}`,
        type: 'vouch_received',
        actorUserId: vouch.voucherId,
        targetUserId: vouch.voucheeId,
        community: null,
        count: null,
        atMs: vouch.createdAt.getTime(),
        route: '/admin/members',
      });
    }

    const communityIdsForFeed = [
      ...new Set(
        input.recentCommunityMembersForFeed.map(
          (communityMember) => communityMember.communityId,
        ),
      ),
    ];
    const communitiesById = communityIdsForFeed.length
      ? await this.communities.find({ where: { id: In(communityIdsForFeed) } })
      : [];
    const communityById = new Map<string, Community>(
      communitiesById.map((community) => [community.id, community]),
    );
    for (const communityMember of input.recentCommunityMembersForFeed) {
      const community = communityById.get(communityMember.communityId);
      feedCandidates.push({
        id: `community-joined-${communityMember.id}`,
        type: 'community_joined',
        actorUserId: communityMember.userId,
        targetUserId: null,
        community: community?.name ?? null,
        count: null,
        atMs: communityMember.joinedAt.getTime(),
        route: community
          ? `/admin/communities/${community.slug}/mod`
          : '/admin/communities',
      });
    }

    for (const joinRequest of input.recentJoinRequestsForFeed) {
      feedCandidates.push({
        id: `join-request-${joinRequest.id}`,
        type: 'join_request_submitted',
        actorUserId: null,
        // No account/profile exists yet for a join-request applicant (see
        // the entity's doc) — the name on the request itself IS the display
        // name, not something `MemberLookup` could ever resolve.
        actorNameOverride: joinRequest.name,
        targetUserId: null,
        community: null,
        count: null,
        atMs: joinRequest.createdAt.getTime(),
        route: '/admin/members?tab=verification',
      });
    }

    const memberLookup = new MemberLookup(this.profiles);
    const actorAndTargetUserIds = [
      ...new Set(
        feedCandidates
          .flatMap((candidate) => [
            candidate.actorUserId,
            candidate.targetUserId,
          ])
          .filter((userId): userId is string => userId !== null),
      ),
    ];
    const memberRefsByUserId = await memberLookup.byUserIds(
      actorAndTargetUserIds,
    );

    return feedCandidates
      .sort((first, second) => second.atMs - first.atMs)
      .slice(0, FEED_RESULT_LIMIT)
      .map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        actor:
          candidate.actorNameOverride !== undefined
            ? candidate.actorNameOverride
            : this.nameForUserId(candidate.actorUserId, memberRefsByUserId),
        target: this.nameForUserId(candidate.targetUserId, memberRefsByUserId),
        community: candidate.community,
        count: candidate.count,
        at: new Date(candidate.atMs).toISOString(),
        route: candidate.route,
      }));
  }

  private nameForUserId(
    userId: string | null,
    memberRefsByUserId: Map<string, MemberRef>,
  ): string | null {
    if (!userId) return null;
    const memberRef = memberRefsByUserId.get(userId);
    if (!memberRef) return null;
    return `${memberRef.firstName} ${memberRef.lastName}`.trim();
  }

  /** `weekCount` empty buckets, oldest first, each stamped with the ISO
   *  instant its 7-day window opens — `weekBucketIndex` maps a timestamp to
   *  the matching position in the SAME array. */
  private buildEmptyWeeklyBuckets<BucketValue>(
    now: Date,
    weekCount: number,
    makeEmptyValue: () => BucketValue,
  ): { weekStartMs: number; value: BucketValue }[] {
    const buckets: { weekStartMs: number; value: BucketValue }[] = [];
    // Iterating from the oldest week (weeksAgo = weekCount) down to the
    // newest (weeksAgo = 1) builds the array already in the oldest-first
    // order the DTO requires — no separate reverse step.
    for (let weeksAgo = weekCount; weeksAgo >= 1; weeksAgo -= 1) {
      buckets.push({
        weekStartMs: now.getTime() - weeksAgo * WEEK_MS,
        value: makeEmptyValue(),
      });
    }
    return buckets;
  }

  /** Maps `occurredAt` to its position in a `buildEmptyWeeklyBuckets(now,
   *  weekCount, ...)` array, or `null` if it falls outside the window
   *  entirely (older than `weekCount` weeks, or somehow in the future). */
  private weekBucketIndex(
    now: Date,
    occurredAt: Date,
    weekCount: number,
  ): number | null {
    const weeksAgoFromNewest = Math.floor(
      (now.getTime() - occurredAt.getTime()) / WEEK_MS,
    );
    if (weeksAgoFromNewest < 0 || weeksAgoFromNewest >= weekCount) return null;
    return weekCount - 1 - weeksAgoFromNewest;
  }
}
