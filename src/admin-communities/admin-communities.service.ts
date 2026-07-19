import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { Community } from '../communities/entities/community.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminCommunityCardDTO,
  AdminCommunityDetailDTO,
  AdminCommunityModeratorDTO,
  AdminCommunityQueueItemDTO,
  CommunityAggregates,
  toAdminCommunityCard,
  toAdminCommunityDetail,
  toAdminModerator,
} from './admin-communities-response';
import {
  CommunityReportTotals,
  summariseReportsByCommunity,
} from './community-report-scope';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The sparkline is always this many weekly buckets, oldest first. The admin
 *  UI divides by `length - 1` to space the points, so a short array would
 *  render as NaN — a quiet community gets eight zeros, never fewer. */
const SPARKLINE_WEEK_COUNT = 8;
const SPARKLINE_WINDOW_MS = SPARKLINE_WEEK_COUNT * WEEK_MS;

/** Roster roles that count as moderation staff. Plain members are excluded. */
const MODERATOR_ROLES = [RosterRole.Owner, RosterRole.Mod];

/** Subject types whose reports can ever be attributed to a community.
 *  `member`, `venue` and `message` reports have no community and are dropped
 *  by `summariseReportsByCommunity` anyway — excluding them here keeps the
 *  fetch itself narrow. */
const COMMUNITY_SCOPED_SUBJECT_TYPES = [
  ReportSubjectType.Post,
  ReportSubjectType.Reply,
  ReportSubjectType.Community,
];

// `post`/`reply` subject ids end up bound against `post.id`/`reply.id`, both
// `@PrimaryGeneratedColumn('uuid')`. `Report.subjectId` is only ever validated
// as a 1-200 char string (`CreateReportDto`) — `ReportsService.create` never
// checks it resolves to a real row — so a member can file `POST /reports`
// with a non-UUID `subjectId` (e.g. `"x"`) and Postgres will reject any `IN
// (...)` that binds it against a uuid column with "invalid input syntax for
// type uuid", 500ing this read model on every dashboard load until the row is
// deleted by hand.
//
// Defined locally rather than imported from `ModerationService` (the only
// other place this pattern exists, at `src/moderation/moderation.service.ts`
// ~L62): that constant is a private implementation detail of a different
// feature module's service class, not exported, and not a shared utility —
// importing it would mean either reaching into another module's internals or
// widening moderation's public surface just to hand this module one regex.
// Same pattern, deliberately duplicated rather than coupled.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of the 56-day activity windows, shared by posts and replies. */
interface CommunityActivityRow {
  communityId: string;
  authorId: string;
  createdAt: Date;
}

/** One row of the content-id → community-id maps. */
interface CommunityContentIdRow {
  contentId: string;
  communityId: string;
}

/** The reports for a set of communities, plus the two lookup maps needed to
 *  attribute each one back to its community. Loaded once per request and
 *  shared by the aggregates and the scoped queue. */
interface CommunityReportScope {
  reports: Report[];
  communityIdBySubjectId: Map<string, string>;
  slugToCommunityId: Map<string, string>;
}

function emptyCommunityAggregates(): CommunityAggregates {
  return {
    memberCount: 0,
    activeThisWeek: 0,
    postsThisWeek: 0,
    weeklyActivity: new Array<number>(SPARKLINE_WEEK_COUNT).fill(0),
    totalReportCount: 0,
    openReportCount: 0,
    overdueOpenReportCount: 0,
    severityWeightedOpenLoad: 0,
    // Only meaningful once seeded per-community from `community.createdAt` in
    // `aggregatesForMany`; defaults to 0 (treated as brand-new) for the
    // defensive `?? emptyCommunityAggregates()` fallbacks in `listCommunities`
    // and `getCommunity`, which should never actually be reached.
    communityAgeInDays: 0,
  };
}

/** Whole days elapsed between `community.createdAt` and `now`. Negative
 *  clock skew (a `createdAt` briefly in the future) floors at 0 rather than
 *  going negative, which would otherwise make a community look even younger
 *  than "brand new". */
function communityAgeInDaysFor(createdAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS),
  );
}

/**
 * Read model behind the admin dashboard's communities tab.
 *
 * Every aggregate is computed with queries batched across the whole community
 * set — one query per metric, never one query per community — following the
 * grouped-count pattern in `CommunitiesService.statsForMany`.
 */
@Injectable()
export class AdminCommunitiesService {
  private readonly logger = new Logger(AdminCommunitiesService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly communityPostReplies: Repository<CommunityPostReply>,
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async listCommunities(): Promise<AdminCommunityCardDTO[]> {
    const allCommunities = await this.communities.find({
      order: { createdAt: 'ASC' },
    });
    if (!allCommunities.length) return [];

    const now = new Date();
    // The member and activity windows do not depend on the report scope, so
    // both loads are started together and joined inside `aggregatesForMany`
    // rather than run as two serial round trips.
    const reportScopePromise = this.loadReportScope(allCommunities);
    const aggregatesByCommunityId = await this.aggregatesForMany(
      allCommunities,
      now,
      reportScopePromise,
    );

    const communityCards = allCommunities.map((community) =>
      toAdminCommunityCard(
        community,
        aggregatesByCommunityId.get(community.id) ?? emptyCommunityAggregates(),
      ),
    );

    // Flagged communities sort to the top as a group (worst health first
    // within it); everything else follows, also worst-first. Sorting on raw
    // healthScore alone would put a brand-new, unflagged community — whose
    // score is naturally low simply for lack of accumulated activity — above
    // established communities with a real, open incident. Being flagged and
    // being sorted-to-top are separate decisions; this keeps them in sync.
    communityCards.sort((firstCard, secondCard) => {
      if (firstCard.needsSupport !== secondCard.needsSupport) {
        return firstCard.needsSupport ? -1 : 1;
      }
      return firstCard.healthScore - secondCard.healthScore;
    });
    return communityCards;
  }

  async getCommunity(slug: string): Promise<AdminCommunityDetailDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const now = new Date();
    const reportScopePromise = this.loadReportScope([community]);
    const [aggregatesByCommunityId, moderators, reportScope] =
      await Promise.all([
        this.aggregatesForMany([community], now, reportScopePromise),
        this.moderatorsFor(community.id),
        reportScopePromise,
      ]);

    return toAdminCommunityDetail(
      community,
      aggregatesByCommunityId.get(community.id) ?? emptyCommunityAggregates(),
      moderators,
      this.scopedQueueFor(community, reportScope, now),
    );
  }

  /**
   * Build the full aggregate set for every given community in a fixed number
   * of queries: member counts, the 56-day post and reply activity windows,
   * the content-id maps that let reports be attributed, and the reports
   * themselves. Nothing here scales with the number of communities.
   *
   * `reportScopePromise` is taken unresolved on purpose: only the report
   * summary at the end needs it, so the caller can start it in parallel with
   * the member and activity queries issued here.
   */
  private async aggregatesForMany(
    communitiesInScope: Community[],
    now: Date,
    reportScopePromise: Promise<CommunityReportScope>,
  ): Promise<Map<string, CommunityAggregates>> {
    const aggregatesByCommunityId = new Map<string, CommunityAggregates>(
      communitiesInScope.map((community) => [
        community.id,
        {
          ...emptyCommunityAggregates(),
          communityAgeInDays: communityAgeInDaysFor(community.createdAt, now),
        },
      ]),
    );
    const communityIdsInScope = communitiesInScope.map(
      (community) => community.id,
    );
    // MINOR 2: no empty-`communityIdsInScope` guard here. `listCommunities`
    // already returns at its own `if (!allCommunities.length) return [];`
    // before this method is ever called, and `getCommunity` only ever calls
    // it with a one-element array — so this method is never invoked with an
    // empty scope, and `reportScopePromise` is always observed via the
    // `Promise.all` immediately below regardless.
    const [reportScope, memberCountRows, postActivityRows, replyActivityRows] =
      await Promise.all([
        reportScopePromise,
        this.loadMemberCounts(communityIdsInScope),
        this.loadPostActivity(communityIdsInScope, now),
        this.loadReplyActivity(communityIdsInScope, now),
      ]);

    for (const memberCountRow of memberCountRows) {
      const aggregates = aggregatesByCommunityId.get(
        memberCountRow.communityId,
      );
      if (aggregates) aggregates.memberCount = Number(memberCountRow.count);
    }

    const activeAuthorIdsByCommunityId = new Map<string, Set<string>>(
      communityIdsInScope.map((communityId) => [
        communityId,
        new Set<string>(),
      ]),
    );
    const oneWeekAgoMs = now.getTime() - WEEK_MS;

    for (const postActivityRow of postActivityRows) {
      const aggregates = aggregatesByCommunityId.get(
        postActivityRow.communityId,
      );
      if (!aggregates) continue;
      this.addToSparkline(aggregates.weeklyActivity, postActivityRow, now);
      if (postActivityRow.createdAt.getTime() >= oneWeekAgoMs) {
        aggregates.postsThisWeek += 1;
        activeAuthorIdsByCommunityId
          .get(postActivityRow.communityId)
          ?.add(postActivityRow.authorId);
      }
    }

    for (const replyActivityRow of replyActivityRows) {
      const aggregates = aggregatesByCommunityId.get(
        replyActivityRow.communityId,
      );
      if (!aggregates) continue;
      this.addToSparkline(aggregates.weeklyActivity, replyActivityRow, now);
      if (replyActivityRow.createdAt.getTime() >= oneWeekAgoMs) {
        activeAuthorIdsByCommunityId
          .get(replyActivityRow.communityId)
          ?.add(replyActivityRow.authorId);
      }
    }

    for (const [communityId, activeAuthorIds] of activeAuthorIdsByCommunityId) {
      const aggregates = aggregatesByCommunityId.get(communityId);
      if (aggregates) aggregates.activeThisWeek = activeAuthorIds.size;
    }

    // The buckets are filled newest-week-first above; the DTO contract is
    // oldest first.
    for (const aggregates of aggregatesByCommunityId.values()) {
      aggregates.weeklyActivity.reverse();
    }

    const reportTotalsByCommunityId = summariseReportsByCommunity(
      reportScope.reports,
      reportScope.communityIdBySubjectId,
      reportScope.slugToCommunityId,
      now,
    );
    for (const [communityId, reportTotals] of reportTotalsByCommunityId) {
      const aggregates = aggregatesByCommunityId.get(communityId);
      if (aggregates) this.applyReportTotals(aggregates, reportTotals);
    }

    return aggregatesByCommunityId;
  }

  /** Newest week is index 0 while filling; the caller reverses at the end. */
  private addToSparkline(
    weeklyActivity: number[],
    activityRow: CommunityActivityRow,
    now: Date,
  ): void {
    const weekIndex = Math.floor(
      (now.getTime() - activityRow.createdAt.getTime()) / WEEK_MS,
    );
    if (weekIndex < 0 || weekIndex >= SPARKLINE_WEEK_COUNT) return;
    weeklyActivity[weekIndex] += 1;
  }

  private applyReportTotals(
    aggregates: CommunityAggregates,
    reportTotals: CommunityReportTotals,
  ): void {
    aggregates.totalReportCount = reportTotals.totalReportCount;
    aggregates.openReportCount = reportTotals.openReportCount;
    aggregates.overdueOpenReportCount = reportTotals.overdueOpenReportCount;
    aggregates.severityWeightedOpenLoad = reportTotals.severityWeightedOpenLoad;
  }

  private loadMemberCounts(
    communityIdsInScope: string[],
  ): Promise<Array<{ communityId: string; count: string }>> {
    return this.communityMembers
      .createQueryBuilder('member')
      .select('member.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('member.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .groupBy('member.community_id')
      .getRawMany<{ communityId: string; count: string }>();
  }

  /**
   * Posts created inside the sparkline window. `community_id IS NOT NULL`
   * guards against flat/global posts, which belong to no community and would
   * otherwise form a phantom NULL bucket.
   */
  private loadPostActivity(
    communityIdsInScope: string[],
    now: Date,
  ): Promise<CommunityActivityRow[]> {
    const sparklineWindowStart = new Date(now.getTime() - SPARKLINE_WINDOW_MS);
    return this.communityPosts
      .createQueryBuilder('post')
      .select('post.community_id', 'communityId')
      .addSelect('post.author_id', 'authorId')
      .addSelect('post.created_at', 'createdAt')
      .where('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .andWhere('post.created_at >= :sparklineWindowStart', {
        sparklineWindowStart,
      })
      .getRawMany<CommunityActivityRow>();
  }

  /** Replies carry no `communityId` of their own — they inherit it from the
   *  post they hang off, so the community filter joins through posts. */
  private loadReplyActivity(
    communityIdsInScope: string[],
    now: Date,
  ): Promise<CommunityActivityRow[]> {
    const sparklineWindowStart = new Date(now.getTime() - SPARKLINE_WINDOW_MS);
    return this.communityPostReplies
      .createQueryBuilder('reply')
      .innerJoin(CommunityPost, 'post', 'post.id = reply.post_id')
      .select('post.community_id', 'communityId')
      .addSelect('reply.author_id', 'authorId')
      .addSelect('reply.created_at', 'createdAt')
      .where('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .andWhere('reply.created_at >= :sparklineWindowStart', {
        sparklineWindowStart,
      })
      .getRawMany<CommunityActivityRow>();
  }

  /**
   * Everything needed to attribute reports to communities:
   *
   * - `communityIdBySubjectId` is keyed by BOTH post ids AND reply ids, as
   *   `summariseReportsByCommunity` requires — a map built from only one of
   *   the two content tables silently drops the other subject type's reports.
   * - `slugToCommunityId` resolves `community`-subject reports, whose
   *   `subjectId` is a slug rather than a content id.
   *
   * The join runs reports-first on purpose. Building the id map from the
   * content tables and handing the union to `subjectId: In(...)` made the
   * parameter list grow one bind parameter per post and per reply on the
   * platform; past 65535 of them Postgres rejects the statement outright
   * (`bind message has 65535 parameter formats but N parameters`), and it
   * dragged both content tables into the Node heap on every dashboard load.
   * Reports are the small set, so they are fetched first and only the subject
   * ids they actually reference are resolved — the parameter list is now
   * bounded by the number of community-scoped reports, not by content volume.
   */
  private async loadReportScope(
    communitiesInScope: Community[],
  ): Promise<CommunityReportScope> {
    const communityIdsInScope = communitiesInScope.map(
      (community) => community.id,
    );
    const slugToCommunityId = new Map<string, string>(
      communitiesInScope.map((community) => [community.slug, community.id]),
    );
    const communityIdBySubjectId = new Map<string, string>();

    // Never joined against `reporterId`: it is nullable by design (account
    // erasure NULLs it while keeping the report), so an inner join would
    // silently drop the reports of erased accounts.
    //
    // Projected to only the columns `scopedQueueFor` and
    // `summariseReportsByCommunity` actually read (MINOR 1): every post/reply/
    // community report on the platform is fetched on both admin endpoints —
    // `getCommunity(slug)` in particular pays this just to render one
    // community's queue — so pulling the full row (including `text detail`
    // and `jsonb evidence`) for every one of them is unnecessary weight.
    const reports = await this.reports
      .createQueryBuilder('report')
      .select([
        'report.id',
        'report.subjectType',
        'report.subjectId',
        'report.severity',
        'report.reasonCode',
        'report.detail',
        'report.status',
        'report.slaDueAt',
        'report.createdAt',
      ])
      .where('report.subjectType IN (:...subjectTypes)', {
        subjectTypes: COMMUNITY_SCOPED_SUBJECT_TYPES,
      })
      .orderBy('report.createdAt', 'DESC')
      .getMany();

    // `community` reports carry a slug, resolved through `slugToCommunityId`;
    // only post and reply subjects need a content-id lookup. Non-UUID subject
    // ids are dropped before they can reach the `post.id`/`reply.id IN (...)`
    // clauses below (CRITICAL) — those are `uuid` columns, and a member can
    // file a report with an arbitrary string `subjectId` (see `UUID_RE`'s
    // comment above). Dropping them here is behaviour-preserving: a non-UUID
    // string could never have matched a `post.id` or `reply.id` anyway.
    const reportedContentIds = [
      ...new Set(
        reports
          .filter(
            (report) => report.subjectType !== ReportSubjectType.Community,
          )
          .map((report) => report.subjectId),
      ),
    ].filter((subjectId) => UUID_RE.test(subjectId));

    // `IN ()` is not valid SQL — with nothing to resolve, skip both queries.
    if (!reportedContentIds.length || !communityIdsInScope.length) {
      return { reports, communityIdBySubjectId, slugToCommunityId };
    }

    const [postIdRows, replyIdRows] = await Promise.all([
      this.loadPostCommunityIds(communityIdsInScope, reportedContentIds),
      this.loadReplyCommunityIds(communityIdsInScope, reportedContentIds),
    ]);

    for (const contentIdRow of [...postIdRows, ...replyIdRows]) {
      communityIdBySubjectId.set(
        contentIdRow.contentId,
        contentIdRow.communityId,
      );
    }

    return { reports, communityIdBySubjectId, slugToCommunityId };
  }

  /** Resolves reported post ids to their community. Subject ids that name a
   *  reply, a post outside the scope, or nothing at all simply do not match. */
  private loadPostCommunityIds(
    communityIdsInScope: string[],
    reportedContentIds: string[],
  ): Promise<CommunityContentIdRow[]> {
    return this.communityPosts
      .createQueryBuilder('post')
      .select('post.id', 'contentId')
      .addSelect('post.community_id', 'communityId')
      .where('post.id IN (:...reportedContentIds)', { reportedContentIds })
      .andWhere('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .getRawMany<CommunityContentIdRow>();
  }

  /** Replies carry no community of their own, so a reported reply resolves to
   *  its PARENT POST's community via the join. */
  private loadReplyCommunityIds(
    communityIdsInScope: string[],
    reportedContentIds: string[],
  ): Promise<CommunityContentIdRow[]> {
    return this.communityPostReplies
      .createQueryBuilder('reply')
      .innerJoin(CommunityPost, 'post', 'post.id = reply.post_id')
      .select('reply.id', 'contentId')
      .addSelect('post.community_id', 'communityId')
      .where('reply.id IN (:...reportedContentIds)', { reportedContentIds })
      .andWhere('post.community_id IN (:...communityIdsInScope)', {
        communityIdsInScope,
      })
      .andWhere('post.community_id IS NOT NULL')
      .getRawMany<CommunityContentIdRow>();
  }

  private async moderatorsFor(
    communityId: string,
  ): Promise<AdminCommunityModeratorDTO[]> {
    const moderatorMembers = await this.communityMembers.find({
      where: { communityId, role: In(MODERATOR_ROLES) },
      order: { joinedAt: 'ASC' },
    });
    if (!moderatorMembers.length) return [];

    const memberLookup = new MemberLookup(this.profiles);
    const memberRefsByUserId = await memberLookup.byUserIds(
      moderatorMembers.map((moderatorMember) => moderatorMember.userId),
    );

    const moderators: AdminCommunityModeratorDTO[] = [];
    for (const moderatorMember of moderatorMembers) {
      const memberRef = memberRefsByUserId.get(moderatorMember.userId);
      if (!memberRef) {
        // A moderator with no profile row is exactly the anomaly this admin
        // surface exists to catch — dropping it silently would render the
        // community as unmoderated with no explanation.
        this.logger.warn(
          `Community ${communityId} has a ${moderatorMember.role} (user ${moderatorMember.userId}) with no profile row; omitting from the moderator list.`,
        );
        continue;
      }
      moderators.push(
        toAdminModerator(
          memberRef,
          moderatorMember.role === RosterRole.Owner ? 'owner' : 'mod',
          moderatorMember.joinedAt,
        ),
      );
    }
    return moderators;
  }

  /** That community's open reports, newest first. */
  private scopedQueueFor(
    community: Community,
    reportScope: CommunityReportScope,
    now: Date,
  ): AdminCommunityQueueItemDTO[] {
    return reportScope.reports
      .filter((report) => {
        if (report.status !== ReportStatus.Open) return false;
        const communityId =
          report.subjectType === ReportSubjectType.Community
            ? reportScope.slugToCommunityId.get(report.subjectId)
            : reportScope.communityIdBySubjectId.get(report.subjectId);
        return communityId === community.id;
      })
      .sort(
        (firstReport, secondReport) =>
          secondReport.createdAt.getTime() - firstReport.createdAt.getTime(),
      )
      .map((report) => ({
        id: report.id,
        severity: report.severity,
        reasonCode: report.reasonCode,
        detail: report.detail,
        status: report.status,
        overdue: report.slaDueAt.getTime() < now.getTime(),
        createdAt: report.createdAt.toISOString(),
      }));
  }
}
