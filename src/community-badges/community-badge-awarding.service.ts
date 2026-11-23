import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AWARD_QUALIFYING_MEMBERS_SQL,
  MARK_AWARDS_NOTIFIED_SQL,
  MEMBER_BADGE_COUNTS_SQL,
  type CommunityMemberBadgeCounts,
} from './community-badge-counts';

/**
 * The community an award run belongs to. Parameters: `[communityId]`.
 */
export const COMMUNITY_FOR_AWARDING_SQL = `SELECT "id", "slug", "name", "parent_id" FROM "communities" WHERE "id" = $1`;

/**
 * The enabled badges of one community with the fields the bell copy needs.
 * Parameters: `[communityId]`.
 */
export const ENABLED_BADGES_FOR_AWARDING_SQL = `SELECT "id", "name", "starter_key", "icon_key", "tint", "backfill_requested_at" FROM "community_badges" WHERE "community_id" = $1 AND "is_enabled" ORDER BY "created_at" ASC, "id" ASC`;

/** A community row as `COMMUNITY_FOR_AWARDING_SQL` returns it. */
interface AwardingCommunityRow {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
}

/** A badge row as `ENABLED_BADGES_FOR_AWARDING_SQL` returns it. */
interface AwardingBadgeRow {
  id: string;
  name: string;
  starter_key: string | null;
  icon_key: string;
  tint: string;
  backfill_requested_at: Date | null;
}

/** One new award as `AWARD_QUALIFYING_MEMBERS_SQL` returns it. */
interface InsertedAwardRow {
  id: string;
  badge_id: string;
  user_id: string;
}

/** A counts row as `MEMBER_BADGE_COUNTS_SQL` returns it. */
interface MemberCountsRow {
  tenure_days: number | string;
  events_checked_in: number | string;
  volunteer_hours: number | string;
  posts_and_replies: number | string;
}

/** The query surface an award run needs, a transaction manager or the pool. */
type AwardingQueryRunner = Pick<EntityManager, 'query'>;

/** The error class name, so a log line carries no message text or ids. */
function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Community badges: reads a member's counts and inserts the awards a member
 * or a whole roster now qualifies for, through the shared counts CTE.
 * Idempotent by `UQ_community_badge_awards_badge_user`, so a repeat run awards
 * nothing twice. A notifying run writes one `community_badge_earned` per badge
 * for its new holders, skipping any badge whose backfill is still pending, so
 * history never rings the bell. Badges never touch recognition: no read or
 * write of the recognition stats, awards or the XP ledger. Awarding never sets
 * `worn_badge_id`; wearing flair is the member's own choice.
 */
@Injectable()
export class CommunityBadgeAwardingService {
  private readonly logger = new Logger(CommunityBadgeAwardingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * One member's four counts in one community, or null when the member holds
   * no roster row in a top-level community.
   */
  async memberCounts(
    communityId: string,
    userId: string,
  ): Promise<CommunityMemberBadgeCounts | null> {
    const rows: MemberCountsRow[] = await this.dataSource.query(
      MEMBER_BADGE_COUNTS_SQL,
      [communityId, userId],
    );
    const [row] = rows;
    if (!row) {
      return null;
    }
    return {
      tenureDays: Number(row.tenure_days),
      eventsCheckedIn: Number(row.events_checked_in),
      volunteerHours: Number(row.volunteer_hours),
      postsAndReplies: Number(row.posts_and_replies),
    };
  }

  /**
   * Awards one member every enabled badge they now qualify for and returns
   * the number of new awards. A missing community, a space or a community
   * with no enabled badge returns 0 before any count runs.
   */
  async evaluateMember(input: {
    communityId: string;
    userId: string;
    shouldNotify: boolean;
  }): Promise<number> {
    return this.runAward(
      this.dataSource,
      input.communityId,
      [input.communityId, input.userId, null, false],
      input.shouldNotify,
    );
  }

  /**
   * Awards the whole roster every qualifying badge, optionally limited to
   * `badgeIds`, and returns the number of new awards. `onlyReadyBadges` skips
   * badges whose backfill is still pending. Every query of the call runs on
   * `manager` when given, so a job can award inside its own transaction. A
   * call with `manager` is always silent, since the bell write cannot join
   * that transaction.
   */
  async awardCommunity(
    input: {
      communityId: string;
      badgeIds: string[] | null;
      shouldNotify: boolean;
      onlyReadyBadges: boolean;
    },
    manager?: AwardingQueryRunner,
  ): Promise<number> {
    return this.runAward(
      manager ?? this.dataSource,
      input.communityId,
      [input.communityId, null, input.badgeIds, input.onlyReadyBadges],
      manager === undefined && input.shouldNotify,
    );
  }

  /** Shared body of both award entry points. */
  private async runAward(
    queryRunner: AwardingQueryRunner,
    communityId: string,
    awardParameters: [string, string | null, string[] | null, boolean],
    shouldNotify: boolean,
  ): Promise<number> {
    const communityRows: AwardingCommunityRow[] = await queryRunner.query(
      COMMUNITY_FOR_AWARDING_SQL,
      [communityId],
    );
    const [community] = communityRows;
    if (!community || community.parent_id !== null) {
      return 0;
    }
    const badgeRows: AwardingBadgeRow[] = await queryRunner.query(
      ENABLED_BADGES_FOR_AWARDING_SQL,
      [communityId],
    );
    if (!badgeRows.length) {
      return 0;
    }
    const insertedRows: InsertedAwardRow[] = await queryRunner.query(
      AWARD_QUALIFYING_MEMBERS_SQL,
      awardParameters,
    );
    if (shouldNotify && insertedRows.length) {
      const badgesById = new Map(badgeRows.map((badge) => [badge.id, badge]));
      await this.notifyNewAwards(
        queryRunner,
        community,
        badgesById,
        insertedRows,
      );
    }
    return insertedRows.length;
  }

  /**
   * One `community_badge_earned` fan-out per badge with no actor, then marks
   * the awards the bell accepted as notified. A badge with a pending backfill
   * is skipped. A failure is logged with its error class and the awards stay.
   */
  private async notifyNewAwards(
    queryRunner: AwardingQueryRunner,
    community: AwardingCommunityRow,
    badgesById: Map<string, AwardingBadgeRow>,
    rows: InsertedAwardRow[],
  ): Promise<void> {
    const userIdsByBadgeId = new Map<string, string[]>();
    for (const row of rows) {
      const badge = badgesById.get(row.badge_id);
      if (!badge || badge.backfill_requested_at !== null) {
        continue;
      }
      const userIds = userIdsByBadgeId.get(row.badge_id) ?? [];
      userIds.push(row.user_id);
      userIdsByBadgeId.set(row.badge_id, userIds);
    }
    for (const [badgeId, userIds] of userIdsByBadgeId) {
      const badge = badgesById.get(badgeId);
      if (!badge) {
        continue;
      }
      try {
        const notifiedUserIds = await this.notifications.createForRecipients(
          userIds,
          NotificationType.CommunityBadgeEarned,
          {
            communitySlug: community.slug,
            communityName: community.name,
            badgeId: badge.id,
            badgeName: badge.name,
            starterKey: badge.starter_key,
            iconKey: badge.icon_key,
            tint: badge.tint,
          },
        );
        if (notifiedUserIds.length) {
          await queryRunner.query(MARK_AWARDS_NOTIFIED_SQL, [
            badge.id,
            notifiedUserIds,
          ]);
        }
      } catch (error) {
        this.logger.warn(
          `Community badge notification failed for community ${community.id}: ${errorClassName(error)}`,
        );
      }
    }
  }
}
