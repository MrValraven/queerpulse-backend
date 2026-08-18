import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
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
import { Community } from './entities/community.entity';

/** Report `subjectId` is a varchar carrying a uuid for post/reply subjects. A
 *  non-uuid value can't match a content id and would 500 a uuid-typed lookup,
 *  so it's filtered before any id query — mirrors `admin-communities.service`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const shouldFreeze =
      isEmergency ||
      (await this.openReportCount(community)) >= SUPPORT_OPEN_REPORT_THRESHOLD;
    if (!shouldFreeze) return;

    // Conditional UPDATE so two reports racing don't both fire (and so a
    // community archived/frozen in the meantime is left alone). `affected === 0`
    // just means someone else won — nothing to do.
    const result = await this.communities
      .createQueryBuilder()
      .update(Community)
      .set({ frozenAt: () => 'now()' })
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

  private async communityForPostId(postId: string): Promise<Community | null> {
    if (!UUID_RE.test(postId)) return null;
    const post = await this.posts.findOne({
      where: { id: postId },
      select: { communityId: true },
    });
    if (!post?.communityId) return null; // flat post: no community
    return this.communities.findOne({ where: { id: post.communityId } });
  }

  /** Open reports scoped to this community: its own `community`-subject reports
   *  plus reports on its posts and replies. */
  private async openReportCount(community: Community): Promise<number> {
    const postRows = await this.posts.find({
      where: { communityId: community.id },
      select: { id: true },
    });
    const postIds = postRows.map((post) => post.id);
    const replyIds = postIds.length
      ? (
          await this.replies
            .createQueryBuilder('reply')
            .select('reply.id', 'id')
            .where('reply.post_id IN (:...postIds)', { postIds })
            .getRawMany<{ id: string }>()
        ).map((row) => row.id)
      : [];
    const contentIds = [...postIds, ...replyIds];

    return this.reports
      .createQueryBuilder('report')
      .where('report.status = :open', { open: ReportStatus.Open })
      .andWhere(
        new Brackets((where) => {
          where.where(
            'report.subject_type = :communityType AND report.subject_id = :slug',
            {
              communityType: ReportSubjectType.Community,
              slug: community.slug,
            },
          );
          if (contentIds.length) {
            where.orWhere(
              'report.subject_type IN (:...contentTypes) AND report.subject_id IN (:...contentIds)',
              {
                contentTypes: [ReportSubjectType.Post, ReportSubjectType.Reply],
                contentIds,
              },
            );
          }
        }),
      )
      .getCount();
  }
}
