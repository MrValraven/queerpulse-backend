import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import { SUPPORT_OPEN_REPORT_THRESHOLD } from '../admin-communities/admin-communities-response';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { REPORT_CREATED, ReportCreatedEvent } from '../reports/report.events';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community, CommunityFrozenReason } from './entities/community.entity';

/** Report `subjectId` is a varchar carrying a uuid for post/reply subjects. A
 *  non-uuid value can't match a content id and would 500 a uuid-typed lookup,
 *  so it's filtered before any id query — mirrors `admin-communities.service`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many DISTINCT members must be holding an open report against a community
 * before the pile-up trigger fires, on top of `SUPPORT_OPEN_REPORT_THRESHOLD`
 * open reports overall. Three, so that neither one determined member nor a
 * pair of them can freeze a community between them (BE-COM-20).
 */
const MIN_PILEUP_REPORTERS = 3;

/**
 * Reacts to a new report by auto-freezing its community when
 * `autoFreezeOnReports` is on and either the report is an emergency
 * (doxxing/outing) or the community's open reports have piled up to
 * SUPPORT_OPEN_REPORT_THRESHOLD. Freezing keeps the community visible but blocks
 * new joins and new posts from plain members (see `Community.frozenAt`) until an
 * owner/mod lifts it.
 *
 * A listener, not an inline call in `ReportsService`, so the reports module
 * stays decoupled from communities — and by contract (see ReportCreatedEvent)
 * anything thrown here is swallowed and must never fail the report filing.
 */
@Injectable()
export class CommunityAutoFreezeService {
  private readonly logger = new Logger(CommunityAutoFreezeService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    private readonly governanceLog: CommunityGovernanceLogService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(REPORT_CREATED)
  async onReportCreated(event: ReportCreatedEvent): Promise<void> {
    try {
      await this.maybeFreeze(event);
    } catch (error) {
      // Best-effort: a freeze failure must never surface to the reporter or
      // fail the filing that produced this event.
      this.logger.warn(
        `auto-freeze check failed for report ${event.reportId}: ${String(error)}`,
      );
    }
  }

  private async maybeFreeze(event: ReportCreatedEvent): Promise<void> {
    const community = await this.resolveCommunity(event);
    if (!community) return; // report isn't attributable to a community
    if (!community.autoFreezeOnReports) return; // policy off
    if (community.frozenAt || community.archivedAt) return; // already frozen / down

    const isEmergency = event.severity === ReportSeverity.Emergency;
    // Pile-up now needs BOTH the volume it always did and a floor on how many
    // DIFFERENT people are behind it. The dedupe index on `reports` keys on
    // `reason_code`, so one member can legitimately hold several open reports
    // on the same post (one per reason) — five of them, filed well inside the
    // `/reports` 10-per-minute throttle, used to be enough for ONE person to
    // freeze any community with `autoFreezeOnReports` on, and to do it again
    // after every staff unfreeze (BE-COM-20). A pile-up is meant to be a
    // signal about the community, which a single reporter cannot produce.
    //
    // The emergency trigger is deliberately left as a single-reporter one: an
    // outing/doxxing report has to be able to stop a community on its own.
    // That is also the trigger `CommunitiesService.unfreeze`'s gate protects.
    const shouldFreeze = isEmergency || (await this.isReportPileUp(community));
    if (!shouldFreeze) return;

    // Conditional UPDATE so two reports racing don't both fire (and so a
    // community archived/frozen in the meantime is left alone). `affected === 0`
    // just means someone else won — nothing to do.
    //
    // `frozenReason` is stamped alongside the marker so `CommunitiesService
    // .unfreeze` can tell this automatic freeze apart from a manual one an
    // owner set themselves: an owner may lift their own manual freeze at will,
    // but an outing/doxxing freeze only once the reports behind it are handled
    // (BE-COM-04).
    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({
        frozenAt: () => 'now()',
        frozenReason: isEmergency
          ? CommunityFrozenReason.EmergencyReport
          : CommunityFrozenReason.ReportPileup,
      })
      .where('id = :id AND frozen_at IS NULL AND archived_at IS NULL', {
        id: community.id,
      })
      .execute();
    if (result.affected) {
      this.logger.log(
        `auto-froze community ${community.slug} (report ${event.reportId}, trigger: ${
          isEmergency ? 'emergency' : 'pile-up'
        })`,
      );
      await this.logAndNotifyFreeze(community, isEmergency);
    }
  }

  /**
   * Governance-log + staff notification for an auto-freeze that has already
   * committed (the conditional UPDATE above). Own try/catch per step — this
   * runs after the freeze itself succeeded, so a failure here must never make
   * `maybeFreeze`'s caller (`onReportCreated`) think the freeze didn't
   * happen, and must never roll it back (there's nothing left to roll back:
   * no surrounding transaction ties these together).
   */
  private async logAndNotifyFreeze(
    community: Community,
    isEmergency: boolean,
  ): Promise<void> {
    const reason = isEmergency ? 'emergency_report' : 'report_pileup';
    try {
      await this.governanceLog.log({
        communityId: community.id,
        actorUserId: null,
        action: GovernanceLogAction.Frozen,
        metadata: { reason },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write governance log for auto-freeze of community ${community.id}: ${String(error)}`,
      );
    }
    try {
      const staff = await this.members.find({
        where: {
          communityId: community.id,
          role: In([RosterRole.Owner, RosterRole.Mod]),
        },
        select: { userId: true },
      });
      const recipientIds = [
        ...new Set(
          [community.ownerId, ...staff.map((row) => row.userId)].filter(
            (id): id is string => id !== null,
          ),
        ),
      ];
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunityFrozen,
        { source: 'community', communitySlug: community.slug, reason },
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify staff of auto-freeze for community ${community.id}: ${String(error)}`,
      );
    }
  }

  /** The community a report belongs to, or null when it isn't community-scoped
   *  (member/message/venue/… subjects, or a flat post with no community). */
  private async resolveCommunity(
    event: ReportCreatedEvent,
  ): Promise<Community | null> {
    if (event.subjectType === ReportSubjectType.Community) {
      return this.communities.findOne({ where: { slug: event.subjectId } });
    }
    if (event.subjectType === ReportSubjectType.Post) {
      return this.communityForPostId(event.subjectId);
    }
    if (event.subjectType === ReportSubjectType.Reply) {
      if (!UUID_RE.test(event.subjectId)) return null;
      const reply = await this.replies.findOne({
        where: { id: event.subjectId },
        select: { postId: true },
      });
      return reply ? this.communityForPostId(reply.postId) : null;
    }
    return null;
  }

  /**
   * Whether this community's open reports amount to a genuine pile-up:
   * `SUPPORT_OPEN_REPORT_THRESHOLD` open reports AND at least
   * `MIN_PILEUP_REPORTERS` distinct people behind them (see `maybeFreeze`).
   */
  private async isReportPileUp(community: Community): Promise<boolean> {
    const openReports = await this.openReportCount(community);
    if (openReports < SUPPORT_OPEN_REPORT_THRESHOLD) return false;
    const reporters = await this.distinctOpenReporterCount(community);
    return reporters >= MIN_PILEUP_REPORTERS;
  }

  private async communityForPostId(postId: string): Promise<Community | null> {
    if (!UUID_RE.test(postId)) return null;
    const post = await this.posts.findOne({
      where: { id: postId },
      select: { communityId: true },
    });
    if (!post?.communityId) return null; // flat post: no community
    return this.communities.findOne({ where: { id: post.communityId } });
  }

  /**
   * Open reports scoped to this community: its own `community`-subject reports
   * plus reports on its posts and replies.
   *
   * Public because `CommunitiesService.unfreeze` reuses the exact same count
   * to decide whether an AUTOMATIC freeze may be lifted yet (BE-COM-04) —
   * "the reports were handled" has to mean the same thing on both sides of
   * the freeze, so there is one implementation, not two.
   *
   * Joined, not an `IN (...)` list. This used to load every post id AND every
   * reply id of the community into Node and bind them as one parameter list,
   * which Postgres rejects past 65535 parameters — and this runs inside the
   * `REPORT_CREATED` listener, whose `catch` swallows the failure, so
   * auto-freeze would have silently stopped working for exactly the busiest
   * communities (BE-COM-13). The `EXISTS` subqueries compare
   * `<content>.id::text` against `reports.subject_id` (a varchar that carries
   * slugs as well as uuids, so the uuid side is cast rather than the varchar
   * — casting `subject_id` to uuid would throw on a `community`-subject row).
   */
  async openReportCount(community: Community): Promise<number> {
    return this.openReportsScoped(community).getCount();
  }

  /**
   * The number of DISTINCT members currently holding an open report against
   * this community — the pile-up trigger's real measure (see `maybeFreeze`).
   *
   * A report with no `reporterId` (an account-less reporter who left only a
   * contact email) counts as its own distinct reporter rather than being
   * dropped by `COUNT(DISTINCT ...)`'s NULL handling, which would otherwise
   * make anonymous-only pile-ups invisible to this trigger.
   */
  async distinctOpenReporterCount(community: Community): Promise<number> {
    const row = await this.openReportsScoped(community)
      .select(
        `COUNT(DISTINCT COALESCE(report.reporter_id::text, 'anon:' || report.id::text))`,
        'count',
      )
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  /**
   * The shared scope predicate behind both counts above: OPEN reports whose
   * subject is this community, one of its posts, or one of its replies.
   */
  private openReportsScoped(community: Community): SelectQueryBuilder<Report> {
    return this.reports
      .createQueryBuilder('report')
      .where('report.status = :open', { open: ReportStatus.Open })
      .andWhere(
        new Brackets((where) => {
          where
            .where(
              'report.subject_type = :communityType AND report.subject_id = :slug',
              {
                communityType: ReportSubjectType.Community,
                slug: community.slug,
              },
            )
            .orWhere(
              `report.subject_type = :postType AND EXISTS (
                SELECT 1 FROM "community_posts" "__scoped_post"
                WHERE "__scoped_post"."id"::text = report.subject_id
                  AND "__scoped_post"."community_id" = :communityId
              )`,
              {
                postType: ReportSubjectType.Post,
                communityId: community.id,
              },
            )
            .orWhere(
              `report.subject_type = :replyType AND EXISTS (
                SELECT 1 FROM "community_post_replies" "__scoped_reply"
                JOIN "community_posts" "__scoped_reply_post"
                  ON "__scoped_reply_post"."id" = "__scoped_reply"."post_id"
                WHERE "__scoped_reply"."id"::text = report.subject_id
                  AND "__scoped_reply_post"."community_id" = :communityId
              )`,
              {
                replyType: ReportSubjectType.Reply,
                communityId: community.id,
              },
            );
        }),
      );
  }
}
