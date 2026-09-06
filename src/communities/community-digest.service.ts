import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Event, EventStatus } from '../events/entities/event.entity';
import { toImageUrl } from '../common/image-url';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { isCommunityStaffRole } from './community-staff-access';
import {
  CommunityDigestEntry,
  CommunityDigestExcerpt,
  CommunityDigestResponse,
  DIGEST_EXCERPTS_PER_COMMUNITY,
  DIGEST_EXCERPT_LENGTH,
  DIGEST_WINDOW_DAYS,
} from './community-digest-response';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import {
  CommunityMember,
  CommunityNotificationLevel,
} from './entities/community-member.entity';
import { CommunityPost, PostKind } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

const DIGEST_WINDOW_MS = DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface CountRow {
  communityId: string;
  count: string;
}

interface ExcerptRow {
  id: string;
  community_id: string;
  body: string;
  kind: PostKind;
  created_at: Date;
}

/**
 * Backs `GET /me/communities/digest` — "what happened in my communities this
 * week", across all of them at once.
 *
 * The whole point of this service is that it is BATCHED. A member of eight
 * communities costs the same number of round trips as a member of one: the
 * roster read resolves every membership, and each of the six lanes (new posts,
 * new members, upcoming gatherings, representative excerpts, pending join
 * requests, open reports) is a single query over the whole id set, grouped or
 * window-partitioned in Postgres. Nothing in here loops over communities to
 * query.
 *
 * Query budget, fixed regardless of how many communities the caller belongs
 * to. Six for a caller who moderates none of them, eight for a caller who
 * moderates any number of them:
 *   1. the caller's roster rows (not muted)
 *   2. the communities themselves, by id
 *   3. new posts per community, GROUP BY community_id
 *   4. new members per community, GROUP BY community_id
 *   5. upcoming gatherings per community, GROUP BY community_id
 *   6. up to `DIGEST_EXCERPTS_PER_COMMUNITY` posts per community, via one
 *      ROW_NUMBER() window partitioned by community_id
 *   7. pending join requests per community, GROUP BY community_id, over the
 *      MODERATED subset of the ids only (skipped entirely when that subset is
 *      empty, which is the common case)
 *   8. open reports per community, GROUP BY community_id, over that same
 *      moderated subset (skipped the same way)
 *
 * Lanes 7 and 8 carry moderation state, so they are gated on the caller's own
 * roster role: see `staffCommunityIds` in `getDigest`.
 *
 * A standalone service (and its own controller) rather than a method on
 * `CommunitiesService`, following this module's convention: see
 * `CommunityPulseController`'s doc comment.
 */
@Injectable()
export class CommunityDigestService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    // Read-only, for the pending-join-request lane. Registered once in
    // `CommunitiesModule`'s `forFeature`, shared with `CommunitiesService`.
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    // Read-only, for the open-report lane. Same cross-module `forFeature`
    // reuse `CommunityAutoFreezeService` and `CommunityPostsService` already
    // have on this entity inside this module.
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
  ) {}

  async getDigest(userId: string): Promise<CommunityDigestResponse> {
    const now = new Date();
    const since = new Date(now.getTime() - DIGEST_WINDOW_MS);

    // 1. Every membership the caller has NOT muted. A mute is a request to
    // stop hearing from a community, and a digest is hearing from it, so the
    // exclusion happens here at the source rather than as a filter later.
    const memberships = await this.members.find({
      where: {
        userId,
        notificationLevel: Not(CommunityNotificationLevel.Muted),
      },
      select: { communityId: true, role: true, notificationLevel: true },
    });
    if (!memberships.length) {
      return { since, communities: [] };
    }
    const communityIds = memberships.map(
      (membership) => membership.communityId,
    );

    // 2. The communities themselves. Archived ones drop out: a community taken
    // down should not keep filing weekly reports.
    const communities = await this.communities.find({
      where: { id: In(communityIds), archivedAt: IsNull() },
      select: { id: true, slug: true, name: true, avatarImageUrl: true },
    });
    if (!communities.length) {
      return { since, communities: [] };
    }
    const liveIds = communities.map((community) => community.id);

    const membershipByCommunityId = new Map(
      memberships.map((membership) => [membership.communityId, membership]),
    );

    // 3. The subset of those the caller actually MODERATES (owner, co-owner or
    // moderator, the same tier `resolveStaffCommunity` gates every moderation
    // route on). It is the only id set the two moderation lanes below are ever
    // given, so a plain member's digest cannot carry a count that was never
    // computed for them: how many people have applied to a room, and how many
    // reports are open in it, are facts about the people in it, and belonging
    // to a room is not a reason to be told them.
    //
    // Derived from the caller's OWN roster rows, already loaded above, so the
    // gate costs no extra query.
    const staffCommunityIds = liveIds.filter((communityId) => {
      const membership = membershipByCommunityId.get(communityId);
      return membership != null && isCommunityStaffRole(membership.role);
    });
    const isModeratingAnything = staffCommunityIds.length > 0;

    const [
      newPostRows,
      newMemberRows,
      upcomingGatheringRows,
      excerptRows,
      pendingJoinRequestRows,
      openReportRows,
    ] = await Promise.all([
      this.countNewPosts(liveIds, since),
      this.countNewMembers(liveIds, since),
      this.countUpcomingGatherings(liveIds, now),
      this.loadExcerpts(liveIds, userId, since),
      isModeratingAnything
        ? this.countPendingJoinRequests(staffCommunityIds)
        : Promise.resolve<CountRow[]>([]),
      isModeratingAnything
        ? this.countOpenReports(staffCommunityIds)
        : Promise.resolve<CountRow[]>([]),
    ]);

    const newPostCounts = CommunityDigestService.toCountMap(newPostRows);
    const newMemberCounts = CommunityDigestService.toCountMap(newMemberRows);
    const upcomingCounts = CommunityDigestService.toCountMap(
      upcomingGatheringRows,
    );
    const pendingJoinRequestCounts = CommunityDigestService.toCountMap(
      pendingJoinRequestRows,
    );
    const openReportCounts = CommunityDigestService.toCountMap(openReportRows);
    const excerptsByCommunity =
      CommunityDigestService.groupExcerpts(excerptRows);

    const entries: CommunityDigestEntry[] = [];
    for (const community of communities) {
      const membership = membershipByCommunityId.get(community.id);
      if (!membership) continue;
      // The moderation counts are gated TWICE: the lanes above only ever saw
      // the moderated ids, and this re-asserts the role at the point the
      // number reaches the wire. Belt and braces on purpose, because the
      // failure mode is leaking moderation state to a whole roster.
      const isStaffHere = isCommunityStaffRole(membership.role);
      entries.push({
        slug: community.slug,
        name: community.name,
        avatarImageUrl: toImageUrl(community.avatarImageUrl),
        myRole: membership.role,
        notificationLevel: membership.notificationLevel,
        newPostCount: newPostCounts.get(community.id) ?? 0,
        newMemberCount: newMemberCounts.get(community.id) ?? 0,
        upcomingGatheringCount: upcomingCounts.get(community.id) ?? 0,
        pendingJoinRequestCount: isStaffHere
          ? (pendingJoinRequestCounts.get(community.id) ?? 0)
          : 0,
        openReportCount: isStaffHere
          ? (openReportCounts.get(community.id) ?? 0)
          : 0,
        excerpts: excerptsByCommunity.get(community.id) ?? [],
      });
    }

    // Loudest week first, then alphabetical so the order is stable when two
    // communities had an equally quiet week.
    entries.sort((left, right) => {
      const leftVolume = left.newPostCount + left.newMemberCount;
      const rightVolume = right.newPostCount + right.newMemberCount;
      if (leftVolume !== rightVolume) return rightVolume - leftVolume;
      return left.name.localeCompare(right.name);
    });

    return { since, communities: entries };
  }

  /** Lane 1: posts created in the window, one grouped query for all ids. */
  private countNewPosts(
    communityIds: string[],
    since: Date,
  ): Promise<CountRow[]> {
    return this.posts
      .createQueryBuilder('p')
      .select('p.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('p.community_id IN (:...communityIds)', { communityIds })
      .andWhere('p.deleted_at IS NULL')
      .andWhere('p.created_at >= :since', { since })
      .groupBy('p.community_id')
      .getRawMany<CountRow>();
  }

  /** Lane 2: members who joined in the window, one grouped query for all ids. */
  private countNewMembers(
    communityIds: string[],
    since: Date,
  ): Promise<CountRow[]> {
    return this.members
      .createQueryBuilder('m')
      .select('m.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('m.community_id IN (:...communityIds)', { communityIds })
      .andWhere('m.joined_at >= :since', { since })
      .groupBy('m.community_id')
      .getRawMany<CountRow>();
  }

  /**
   * Lane 3: gatherings still ahead, one grouped query for all ids. Looks
   * FORWARD rather than back (the other two lanes are a review of the week,
   * this one is the reason to open the app), and counts only published events.
   */
  private countUpcomingGatherings(
    communityIds: string[],
    now: Date,
  ): Promise<CountRow[]> {
    return this.events
      .createQueryBuilder('e')
      .select('e.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('e.community_id IN (:...communityIds)', { communityIds })
      .andWhere('e.status = :published', { published: EventStatus.Published })
      .andWhere('e.start_at >= :now', { now })
      .groupBy('e.community_id')
      .getRawMany<CountRow>();
  }

  /**
   * Lane 4: up to `DIGEST_EXCERPTS_PER_COMMUNITY` representative posts per
   * community in ONE query, using `ROW_NUMBER() OVER (PARTITION BY
   * community_id ...)` and keeping the top rows of each partition. The
   * alternative (a `LIMIT 2` query per community) is exactly the N+1 this
   * endpoint exists to avoid.
   *
   * "Representative" means announcements first, then the most recent post, so
   * a week that had an announcement leads with it.
   *
   * The two `NOT EXISTS` clauses are `BlockFilterService.excludeHidden`
   * inlined: that helper takes a `SelectQueryBuilder` and this lane is raw SQL
   * (TypeORM's builder cannot express a windowed subquery cleanly), so the
   * same predicate is written out here against `blocks` and `mutes`. A blocked
   * or muted author's words must not reach the viewer through a digest any
   * more than through a feed.
   */
  private async loadExcerpts(
    communityIds: string[],
    viewerId: string,
    since: Date,
  ): Promise<ExcerptRow[]> {
    return this.posts.query<ExcerptRow[]>(
      `SELECT ranked.id, ranked.community_id, ranked.body, ranked.kind, ranked.created_at
         FROM (
           SELECT p.id,
                  p.community_id,
                  p.body,
                  p.kind,
                  p.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY p.community_id
                    ORDER BY (p.kind = 'announcement') DESC, p.created_at DESC
                  ) AS row_number
             FROM community_posts p
            WHERE p.community_id = ANY($1::uuid[])
              AND p.deleted_at IS NULL
              AND p.created_at >= $2
              AND NOT EXISTS (
                SELECT 1 FROM blocks b
                 WHERE (b.blocker_id = $3 AND b.blocked_id = p.author_id)
                    OR (b.blocked_id = $3 AND b.blocker_id = p.author_id)
              )
              AND NOT EXISTS (
                SELECT 1 FROM mutes mu
                 WHERE mu.muter_id = $3 AND mu.muted_id = p.author_id
              )
         ) ranked
        WHERE ranked.row_number <= $4`,
      [communityIds, since, viewerId, DIGEST_EXCERPTS_PER_COMMUNITY],
    );
  }

  /**
   * Lane 5: people still waiting to be let in, one grouped query for the
   * MODERATED ids.
   *
   * `pending` only. An approved or declined request has been dealt with, and
   * a to-do list that keeps counting settled work is a to-do list nobody
   * trusts. At most one request per (community, member) can be pending at a
   * time (`UQ_community_join_requests_pending`), so this counts people rather
   * than attempts.
   */
  private countPendingJoinRequests(
    staffCommunityIds: string[],
  ): Promise<CountRow[]> {
    return this.joinRequests
      .createQueryBuilder('request')
      .select('request.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('request.community_id IN (:...staffCommunityIds)', {
        staffCommunityIds,
      })
      .andWhere('request.status = :pending', {
        pending: JoinRequestStatus.Pending,
      })
      .groupBy('request.community_id')
      .getRawMany<CountRow>();
  }

  /**
   * Lane 6: open reports per community, one grouped query for the MODERATED
   * ids.
   *
   * COUNTS EXACTLY WHAT THE COMMUNITY'S OWN QUEUE SHOWS. The three arms below
   * mirror `CommunityPostsService.listCommunityReports` clause for clause:
   * status `open`, on one of this community's posts, on a reply under one of
   * them, or (TS-13) on a photograph in the album of a gathering this
   * community hosts. A moderator who reads "3 reports" on the hub and opens
   * the queue has to find three reports there, so there is one definition of
   * open, and it is that one.
   *
   * Deliberately NOT `CommunityAutoFreezeService.openReportCount`, which is a
   * different (wider) number for a different job: it also counts reports whose
   * subject is the COMMUNITY ITSELF, because a community reported for what it
   * is should not be able to unfreeze itself. Those never appear in the
   * community's own queue (they are the platform moderation team's to answer,
   * not the room's), so counting them here would send a moderator to a pane
   * that cannot show them.
   *
   * Raw SQL, like the excerpt lane, because the count has to be grouped by a
   * community id that `reports` does not carry: each arm resolves the owning
   * community through the content it points at, and the three are UNIONed
   * before the GROUP BY. The three arms are disjoint (a report has exactly one
   * `subject_type`), so nothing is counted twice.
   *
   * `<content>.id::text = reports.subject_id` casts the uuid side rather than
   * the varchar one, the same way both existing queue predicates do:
   * `subject_id` carries slugs as well as uuids, so casting IT to uuid throws
   * on a `community`-subject row.
   */
  private countOpenReports(staffCommunityIds: string[]): Promise<CountRow[]> {
    return this.reports.query<CountRow[]>(
      `SELECT scoped.community_id AS "communityId", COUNT(*) AS "count"
         FROM (
           SELECT scoped_post.community_id
             FROM reports report
             JOIN community_posts scoped_post
               ON scoped_post.id::text = report.subject_id
            WHERE report.status = $1
              AND report.subject_type = $2
              AND scoped_post.community_id = ANY($5::uuid[])
           UNION ALL
           SELECT scoped_reply_post.community_id
             FROM reports report
             JOIN community_post_replies scoped_reply
               ON scoped_reply.id::text = report.subject_id
             JOIN community_posts scoped_reply_post
               ON scoped_reply_post.id = scoped_reply.post_id
            WHERE report.status = $1
              AND report.subject_type = $3
              AND scoped_reply_post.community_id = ANY($5::uuid[])
           UNION ALL
           SELECT scoped_photo_event.community_id
             FROM reports report
             JOIN event_photos scoped_photo
               ON scoped_photo.id::text = report.subject_id
             JOIN events scoped_photo_event
               ON scoped_photo_event.id = scoped_photo.event_id
            WHERE report.status = $1
              AND report.subject_type = $4
              AND scoped_photo_event.community_id = ANY($5::uuid[])
         ) scoped
        GROUP BY scoped.community_id`,
      [
        ReportStatus.Open,
        ReportSubjectType.Post,
        ReportSubjectType.Reply,
        ReportSubjectType.EventPhoto,
        staffCommunityIds,
      ],
    );
  }

  private static toCountMap(rows: CountRow[]): Map<string, number> {
    return new Map(rows.map((row) => [row.communityId, Number(row.count)]));
  }

  private static groupExcerpts(
    rows: ExcerptRow[],
  ): Map<string, CommunityDigestExcerpt[]> {
    const grouped = new Map<string, CommunityDigestExcerpt[]>();
    for (const row of rows) {
      const excerpts = grouped.get(row.community_id) ?? [];
      excerpts.push({
        postId: row.id,
        kind: row.kind,
        excerpt: row.body.slice(0, DIGEST_EXCERPT_LENGTH),
        createdAt: row.created_at,
      });
      grouped.set(row.community_id, excerpts);
    }
    return grouped;
  }
}
