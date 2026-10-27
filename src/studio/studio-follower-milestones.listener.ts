import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import {
  SUBPROFILE_FOLLOWED,
  SubprofileFollowedEvent,
} from '../subprofiles/subprofile.events';
import { followerMilestoneThresholdsUpTo } from './studio-milestones';
import { isStudioArtistPersonaKind } from './studio.constants';

/** The persona's stored id, its kind and its follower total right now. */
export const FOLLOWER_TOTAL_SQL = `SELECT "persona"."id" AS "subprofile_id",
       "persona"."kind"::text AS "kind",
       (SELECT COUNT(*)::int FROM "subprofile_followers" "follower"
         WHERE "follower"."subprofile_id" = "persona"."id") AS "follower_count"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1`;

/** One `followers` row per threshold; a threshold already reached stays as it was. */
export const FOLLOWER_MILESTONES_INSERT_SQL = `INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold")
SELECT $1::uuid, 'followers', unnest($2::int[])
ON CONFLICT DO NOTHING`;

interface FollowerTotalRow {
  subprofile_id: string;
  kind: string;
  follower_count: number | string;
}

/**
 * Studio dashboard: follower milestones. `subprofile.followed` fires after
 * the follow commits. Every threshold at or below the follower count is
 * written, so a missed event heals on the next follow and two racing follows
 * write each row once (the unique subject index and `ON CONFLICT DO
 * NOTHING`). An unfollow deletes nothing: a milestone stays once reached.
 * Best effort: a failure is logged and never reaches the emitter.
 */
@Injectable()
export class StudioFollowerMilestonesListener {
  private readonly logger = new Logger(StudioFollowerMilestonesListener.name);

  constructor(private readonly dataSource: DataSource) {}

  @OnEvent(SUBPROFILE_FOLLOWED)
  async recordFollowerMilestones(
    event: SubprofileFollowedEvent,
  ): Promise<void> {
    if (!isFeatureLaunched('studio')) return;
    try {
      const rows: FollowerTotalRow[] = await this.dataSource.query(
        FOLLOWER_TOTAL_SQL,
        [event.subprofileId],
      );
      const row = rows[0];
      if (!row || !isStudioArtistPersonaKind(row.kind)) return;
      const thresholds = followerMilestoneThresholdsUpTo(
        Number(row.follower_count),
      );
      if (thresholds.length === 0) return;
      await this.dataSource.query(FOLLOWER_MILESTONES_INSERT_SQL, [
        row.subprofile_id,
        thresholds,
      ]);
    } catch (error) {
      this.logger.warn(
        `Recording follower milestones failed: ${String(error)}`,
      );
    }
  }
}
