import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface QuizBadgeWinExportRow {
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  event_name_snapshot: string;
  game_number: number;
  won_at: Date;
  hidden_from_profile: boolean;
}

/** One quiz badge the member won, with the event name as it stood at the win. */
export interface QuizBadgeWinExport {
  badgeKey: string;
  badgeName: { en: string; pt: string | null };
  /** The event name snapshot, unmasked: it is the member's own data. */
  eventName: string;
  gameNumber: number;
  wonAt: string;
  /** True when the member hid the badge from their profile. */
  hiddenFromProfile: boolean;
}

interface QuizGameWinExportRow {
  event_title: string | null;
  game_number: number;
  finished_at: Date;
  screen_name: string;
  team_name: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

/** One event game the member won, with the revoke details when staff took it back. */
export interface QuizGameWinExport {
  /** The live event title, null once the event is deleted. */
  eventTitle: string | null;
  gameNumber: number;
  finishedAt: string;
  screenName: string;
  teamName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

/**
 * `events` -> `quizBadgeWins` (quiz win badges): one row per badge the member
 * won at an event game, oldest first, with the badge names, the event name
 * snapshot and whether the member hid the badge from their profile. Raw SQL,
 * so `AccountModule` registers no entity.
 */
@Injectable()
export class QuizBadgeWinsExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'quizBadgeWins';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<QuizBadgeWinExport[]> {
    const rows: QuizBadgeWinExportRow[] = await this.dataSource.query(
      `SELECT "definition"."badge_key" AS "badge_key",
              "definition"."name_en" AS "name_en",
              "definition"."name_pt" AS "name_pt",
              "win"."event_name_snapshot" AS "event_name_snapshot",
              "win"."game_number" AS "game_number",
              "win"."won_at" AS "won_at",
              COALESCE("award"."hidden_from_profile", false) AS "hidden_from_profile"
         FROM "quiz_badge_wins" "win"
         JOIN "quiz_badge_definitions" "definition"
           ON "definition"."id" = "win"."badge_definition_id"
         LEFT JOIN "recognition_awards" "award"
           ON "award"."user_id" = "win"."user_id"
          AND "award"."badge_key" = "definition"."badge_key"
        WHERE "win"."user_id" = $1
        ORDER BY "win"."won_at" ASC, "win"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      badgeKey: row.badge_key,
      badgeName: { en: row.name_en, pt: row.name_pt },
      eventName: row.event_name_snapshot,
      gameNumber: row.game_number,
      wonAt: row.won_at.toISOString(),
      hiddenFromProfile: row.hidden_from_profile,
    }));
  }
}

/**
 * `events` -> `quizGameWins` (quiz win badges): one row per event game the
 * member won, oldest first, with the revoke date and reason when staff took
 * the win back. Who revoked it never leaves. Raw SQL, so `AccountModule`
 * registers no entity.
 */
@Injectable()
export class QuizGameWinsExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'quizGameWins';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<QuizGameWinExport[]> {
    const rows: QuizGameWinExportRow[] = await this.dataSource.query(
      `SELECT "event"."title" AS "event_title",
              "winner"."game_number" AS "game_number",
              "winner"."finished_at" AS "finished_at",
              "winner"."screen_name" AS "screen_name",
              "winner"."team_name" AS "team_name",
              "winner"."revoked_at" AS "revoked_at",
              "winner"."revoke_reason" AS "revoke_reason"
         FROM "quiz_game_winners" "winner"
         LEFT JOIN "events" "event" ON "event"."id" = "winner"."event_id"
        WHERE "winner"."user_id" = $1
        ORDER BY "winner"."finished_at" ASC, "winner"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      eventTitle: row.event_title,
      gameNumber: row.game_number,
      finishedAt: row.finished_at.toISOString(),
      screenName: row.screen_name,
      teamName: row.team_name,
      revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      revokeReason: row.revoke_reason,
    }));
  }
}
