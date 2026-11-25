import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { QUIZ_BADGE_AWARD_LOCK_SQL } from './quiz-win-badges.constants';
import { quizBadgeKeyOf } from './quiz-win-badges.contract';

/**
 * Records one won badge: `$1` badge definition id, `$2` member, `$3` event,
 * `$4` session, `$5` game number, `$6` event name snapshot, `$7` the event was
 * public, `$8` the event was 18+, `$9` the win time. A win that already exists
 * for the same session, badge and member inserts nothing and returns no row.
 */
export const INSERT_QUIZ_BADGE_WIN_SQL = `INSERT INTO "quiz_badge_wins" ("badge_definition_id", "user_id", "event_id", "session_id", "game_number", "event_name_snapshot", "event_was_public", "event_was_adults_only", "won_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT ("session_id", "badge_definition_id", "user_id") DO NOTHING RETURNING "id"`;

/**
 * Gives the member the award row of a quiz badge: `$1` member, `$2` badge key,
 * `$3` hidden from the profile (true for a win at an 18+ event), `$4` award
 * time. An existing award row keeps its visibility and is left as it is.
 */
export const INSERT_QUIZ_BADGE_AWARD_SQL = `INSERT INTO "recognition_awards" ("user_id", "badge_key", "context", "hidden_from_profile", "awarded_at") VALUES ($1, $2, NULL, $3, $4) ON CONFLICT ("user_id", "badge_key") DO NOTHING`;

/**
 * Moves the award row's `awarded_at` to the earliest live win of the badge:
 * `$1` member, `$2` badge definition id, `$3` badge key. A member with no live
 * win of the badge keeps the row unchanged.
 */
export const SYNC_QUIZ_BADGE_AWARD_SQL = `UPDATE "recognition_awards" "award" SET "awarded_at" = "first"."won_at" FROM (SELECT MIN("win"."won_at") AS "won_at" FROM "quiz_badge_wins" "win" WHERE "win"."user_id" = $1 AND "win"."badge_definition_id" = $2) "first" WHERE "award"."user_id" = $1 AND "award"."badge_key" = $3 AND "first"."won_at" IS NOT NULL`;

/**
 * Revokes one winner row once: `$1` winner id, `$2` the revoking admin, `$3`
 * the reason. The guard on `revoked_at` makes a second revoke match nothing.
 */
export const MARK_WINNER_REVOKED_SQL = `UPDATE "quiz_game_winners" SET "revoked_at" = now(), "revoked_by_id" = $2, "revoke_reason" = $3 WHERE "id" = $1 AND "revoked_at" IS NULL RETURNING "session_id", "user_id", "event_id"`;

/**
 * Deletes every badge win of one member in one game: `$1` session, `$2`
 * member. Returns the badge definition id of each deleted win.
 */
export const DELETE_GAME_WINS_SQL = `DELETE FROM "quiz_badge_wins" WHERE "session_id" = $1 AND "user_id" = $2 RETURNING "badge_definition_id"`;

/**
 * Deletes the member's award row of a quiz badge when no live win of it is
 * left: `$1` member, `$2` badge key, `$3` badge definition id. Returns the key
 * when the row went.
 */
export const DELETE_AWARD_WITHOUT_WINS_SQL = `DELETE FROM "recognition_awards" WHERE "user_id" = $1 AND "badge_key" = $2 AND NOT EXISTS (SELECT 1 FROM "quiz_badge_wins" "win" WHERE "win"."user_id" = $1 AND "win"."badge_definition_id" = $3) RETURNING "badge_key"`;

/**
 * Clears the member's bell of the earned notifications of the badges a revoke
 * took away: `$1` member, `$2` the removed badge keys (text[]). A badge the
 * member still holds through another win keeps its notification.
 */
export const DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL = `DELETE FROM "notifications" WHERE "user_id" = $1 AND "type" = '${NotificationType.BadgeEarned}' AND "payload" ->> 'badgeKey' = ANY($2::text[])`;

/**
 * The badges attached to one game of one event, in attach order: `$1` event
 * id, `$2` game number. Archived definitions are included, so a slot that
 * keeps one keeps awarding it.
 */
export const GAME_SLOT_DEFINITIONS_SQL = `SELECT "definition"."id", "definition"."badge_key", "definition"."name_en", "definition"."name_pt" FROM "quiz_event_badge_slots" "slot" JOIN "quiz_badge_definitions" "definition" ON "definition"."id" = "slot"."badge_definition_id" WHERE "slot"."event_id" = $1 AND "slot"."game_number" = $2 ORDER BY "slot"."created_at" ASC, "slot"."id" ASC`;

/**
 * The winner user ids that can receive a badge: `$1` the candidate ids. A
 * missing account and a suspended account are left out (contract note 8).
 */
export const ELIGIBLE_WINNER_USER_IDS_SQL = `SELECT "id" FROM "users" WHERE "id" = ANY($1::uuid[]) AND "status" <> 'suspended'`;

/** The badge an award writes, as the awarding paths read it. */
export interface QuizBadgeAwardDefinition {
  id: string;
  badgeKey: string;
  nameEn: string;
  namePt: string | null;
}

/** One badge to award to one winner of one numbered event game. */
export interface QuizBadgeAwardInput {
  definition: QuizBadgeAwardDefinition;
  userId: string;
  eventId: string;
  sessionId: string;
  gameNumber: number;
  eventName: string;
  eventWasPublic: boolean;
  eventWasAdultsOnly: boolean;
  wonAt: Date;
}

/** A win the award wrote, for the notification sent after the commit. */
export interface QuizBadgeNewWin {
  winId: string;
  userId: string;
  badgeKey: string;
  badgeNameEn: string;
  badgeNamePt: string | null;
  eventName: string;
}

/** What a whole-game revoke took from the member, keys sorted ascending. */
export interface QuizGameWinRevokeOutcome {
  userId: string;
  eventId: string | null;
  revokedBadgeKeys: string[];
  removedAwardKeys: string[];
}

interface InsertedWinRow {
  id: string;
}

interface RevokedWinnerRow {
  session_id: string | null;
  user_id: string;
  event_id: string | null;
}

interface DeletedWinRow {
  badge_definition_id: string;
}

interface DeletedAwardRow {
  badge_key: string;
}

/**
 * The rows of a raw `manager.query` result. On Postgres, TypeORM answers a
 * `SELECT` and an `INSERT ... RETURNING` with the rows, and an
 * `UPDATE ... RETURNING` or `DELETE ... RETURNING` with the pair
 * `[rows, rowCount]` (`src/leads/lead-assignee-access.ts` reads the same pair).
 * Both shapes read here; anything that is not an array reads as no rows.
 */
export function returnedRowsOf<Row>(result: unknown): Row[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0])) return result[0] as Row[];
  return result as Row[];
}

/**
 * Quiz win badges: writes and takes back the wins and award rows of quiz
 * badges inside the caller's transaction, and sends the earned notifications
 * after the commit. Quiz badges stay out of XP: nothing here writes
 * `recognition_stats` or the XP ledger.
 */
@Injectable()
export class QuizBadgeAwardingService {
  private readonly logger = new Logger(QuizBadgeAwardingService.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Contract 5.3 steps 1 to 4: records the win, gives the award row, moves
   * `awarded_at` to the earliest live win, and answers the new win. Answers
   * null when the win already existed, with nothing more written. Takes the
   * member's award lock of the badge first (`QUIZ_BADGE_AWARD_LOCK_SQL`), so a
   * revoke of the same badge for the same member waits for this commit; a
   * caller awarding several pairs goes in badge key order, then member id.
   */
  async awardWin(
    manager: EntityManager,
    input: QuizBadgeAwardInput,
  ): Promise<QuizBadgeNewWin | null> {
    const { definition } = input;
    const badgeKey = quizBadgeKeyOf(definition.id);
    await manager.query(QUIZ_BADGE_AWARD_LOCK_SQL, [input.userId, badgeKey]);
    const insertedRows = returnedRowsOf<InsertedWinRow>(
      await manager.query(INSERT_QUIZ_BADGE_WIN_SQL, [
        definition.id,
        input.userId,
        input.eventId,
        input.sessionId,
        input.gameNumber,
        input.eventName,
        input.eventWasPublic,
        input.eventWasAdultsOnly,
        input.wonAt,
      ]),
    );
    const insertedWin = insertedRows[0];
    if (!insertedWin) return null;

    await manager.query(INSERT_QUIZ_BADGE_AWARD_SQL, [
      input.userId,
      badgeKey,
      input.eventWasAdultsOnly,
      input.wonAt,
    ]);
    await this.syncAwardRow(manager, input.userId, {
      id: definition.id,
      badgeKey,
    });

    return {
      winId: insertedWin.id,
      userId: input.userId,
      badgeKey,
      badgeNameEn: definition.nameEn,
      badgeNamePt: definition.namePt,
      eventName: input.eventName,
    };
  }

  /** Sets the award row's `awarded_at` to the member's earliest live win of
   *  the badge; a member with no live win keeps the row unchanged. */
  async syncAwardRow(
    manager: EntityManager,
    userId: string,
    definition: Pick<QuizBadgeAwardDefinition, 'id' | 'badgeKey'>,
  ): Promise<void> {
    await manager.query(SYNC_QUIZ_BADGE_AWARD_SQL, [
      userId,
      definition.id,
      definition.badgeKey,
    ]);
  }

  /**
   * Contract 5.5 steps 1 to 3: revokes the winner row, deletes every badge win
   * of that member in that game, and for each badge deletes the award row when
   * it was the last live win or moves `awarded_at` otherwise. Each badge step
   * runs under the member's award lock of that badge, taken in badge key
   * order, so a concurrent award of the badge either lands before the check
   * (and keeps the row) or after the delete (and writes it again). The earned
   * notifications of the removed badges leave the member's bell in the same
   * transaction; nothing is sent. The audit row is the caller's. Answers null
   * when the winner was already revoked or does not exist.
   */
  async revokeGameWin(
    manager: EntityManager,
    input: { winnerId: string; actorId: string; reason: string },
  ): Promise<QuizGameWinRevokeOutcome | null> {
    const revokedRows = returnedRowsOf<RevokedWinnerRow>(
      await manager.query(MARK_WINNER_REVOKED_SQL, [
        input.winnerId,
        input.actorId,
        input.reason,
      ]),
    );
    const revokedWinner = revokedRows[0];
    if (!revokedWinner) return null;

    const userId = revokedWinner.user_id;
    const deletedRows =
      revokedWinner.session_id === null
        ? []
        : returnedRowsOf<DeletedWinRow>(
            await manager.query(DELETE_GAME_WINS_SQL, [
              revokedWinner.session_id,
              userId,
            ]),
          );
    const definitionIds = [
      ...new Set(
        deletedRows.map((deletedRow) => deletedRow.badge_definition_id),
      ),
    ].sort((first, second) =>
      quizBadgeKeyOf(first).localeCompare(quizBadgeKeyOf(second)),
    );

    const revokedBadgeKeys: string[] = [];
    const removedAwardKeys: string[] = [];
    for (const definitionId of definitionIds) {
      const badgeKey = quizBadgeKeyOf(definitionId);
      revokedBadgeKeys.push(badgeKey);
      await manager.query(QUIZ_BADGE_AWARD_LOCK_SQL, [userId, badgeKey]);
      const removedRows = returnedRowsOf<DeletedAwardRow>(
        await manager.query(DELETE_AWARD_WITHOUT_WINS_SQL, [
          userId,
          badgeKey,
          definitionId,
        ]),
      );
      if (removedRows.length > 0) {
        removedAwardKeys.push(badgeKey);
      } else {
        await this.syncAwardRow(manager, userId, {
          id: definitionId,
          badgeKey,
        });
      }
    }
    if (removedAwardKeys.length > 0) {
      await manager.query(DELETE_REVOKED_BADGE_NOTIFICATIONS_SQL, [
        userId,
        removedAwardKeys,
      ]);
    }

    return {
      userId,
      eventId: revokedWinner.event_id,
      revokedBadgeKeys,
      removedAwardKeys,
    };
  }

  /**
   * Sends one `badge_earned` notification per new win, one after another. A
   * failed send is logged by the win id and the loop goes on to the next win.
   */
  async notifyNewWins(wins: readonly QuizBadgeNewWin[]): Promise<void> {
    for (const win of wins) {
      try {
        await this.notifications.create(
          win.userId,
          NotificationType.BadgeEarned,
          {
            badgeKey: win.badgeKey,
            badgeName: win.badgeNameEn,
            badgeNamePt: win.badgeNamePt,
            eventName: win.eventName,
          },
        );
      } catch (error) {
        this.logger.warn(
          `Quiz badge notification failed for win ${win.winId}: ${String(error)}`,
        );
      }
    }
  }
}
