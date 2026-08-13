import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { SUPPORT_OPEN_REPORT_THRESHOLD } from '../admin-communities/admin-communities-response';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { REPORT_CREATED, ReportCreatedEvent } from '../reports/report.events';
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
                contentTypes: [
                  ReportSubjectType.Post,
                  ReportSubjectType.Reply,
                ],
                contentIds,
              },
            );
          }
        }),
      )
      .getCount();
  }
}
