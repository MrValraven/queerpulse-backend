import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { notBlockedEitherWaySql } from './studio-discovery-sql';
import { StudioPlayGate } from './studio-play-gate';
import { describePlayErrorWithoutIds } from './studio-play-log';
import { StudioPlayMilestonesService } from './studio-play-milestones.service';
import { personaMemberUserIdsSql } from './studio-persona-members';
import { playableTrackSql } from './studio-playlist-visibility';

/**
 * One row when the play counts, none when it is skipped: a playable track
 * outside podcasts, no block either way with the persona creator, and a
 * caller who is a member of neither the release persona nor a persona with
 * an accepted credit on the track. `$1` track, `$2` caller. No preferences
 * row reads as history on.
 */
export const PLAY_ELIGIBILITY_SQL = `SELECT COALESCE("preferences"."is_listening_history_on", true) AS "is_history_on"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
  LEFT JOIN "member_preferences" "preferences" ON "preferences"."user_id" = $2::uuid
 WHERE "track"."id" = $1::uuid
   AND ${playableTrackSql('track', 'release', 'persona')}
   AND ${notBlockedEitherWaySql('$2::uuid', '"persona"."user_id"', 'play_block')}
   AND "release"."type" <> 'podcast'
   AND NOT EXISTS (
     SELECT 1 FROM ${personaMemberUserIdsSql('"release"."subprofile_id"')} "release_member"
      WHERE "release_member"."user_id" = $2::uuid
   )
   AND NOT EXISTS (
     SELECT 1 FROM "studio_persona_credits" "self_credit"
      WHERE "self_credit"."track_id" = "track"."id"
        AND "self_credit"."status" = 'accepted'
        AND $2::uuid IN ${personaMemberUserIdsSql('"self_credit"."subprofile_id"')}
   )`;

/** Adds one play to the track's total for the current UTC day. `$1` track. */
export const DAILY_PLAY_UPSERT_SQL = `INSERT INTO "studio_track_play_daily" ("track_id", "day", "plays")
VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
ON CONFLICT ("track_id", "day") DO UPDATE SET "plays" = "studio_track_play_daily"."plays" + 1`;

/** One row in the caller's own listening history. `$1` caller, `$2` track. */
export const LISTEN_INSERT_SQL = `INSERT INTO "studio_listens" ("user_id", "track_id") VALUES ($1, $2)`;

interface PlayEligibilityRow {
  is_history_on: boolean;
}

/**
 * Studio listening: records a play (contract section 2). Always silent: every outcome resolves.
 * The in-memory gate runs first, so a skipped call still holds its slot.
 * One eligibility read decides whether the play counts and reads the history switch.
 * One transaction adds the daily total and, with history on, writes the listen.
 * Play milestones follow after the commit. No log line names the track or the member.
 */
@Injectable()
export class StudioPlaysService {
  private readonly logger = new Logger(StudioPlaysService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gate: StudioPlayGate,
    private readonly playMilestones: StudioPlayMilestonesService,
  ) {}

  async recordPlay(userId: string, trackId: string): Promise<void> {
    if (this.gate.admit(userId) !== 'admitted') return;
    try {
      const rows: PlayEligibilityRow[] = await this.dataSource.query(
        PLAY_ELIGIBILITY_SQL,
        [trackId, userId],
      );
      const eligibility = rows[0];
      if (!eligibility) return;

      await this.dataSource.transaction(async (manager) => {
        await manager.query(DAILY_PLAY_UPSERT_SQL, [trackId]);
        if (eligibility.is_history_on) {
          await manager.query(LISTEN_INSERT_SQL, [userId, trackId]);
        }
      });
      await this.playMilestones.recordPlayMilestones(trackId);
    } catch (error) {
      this.logger.warn(
        `Recording a play failed: ${describePlayErrorWithoutIds(error)}`,
      );
    }
  }
}
