import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import {
  QUIZ_EVENT_GAME_FINISHED,
  type QuizEventGameFinishedEvent,
} from '../quizshow/quizshow-game-finished.events';
import { quizshowWriteFailureCode } from '../quizshow/quizshow-persistence.service';
import {
  ELIGIBLE_WINNER_USER_IDS_SQL,
  GAME_SLOT_DEFINITIONS_SQL,
  QuizBadgeAwardingService,
  returnedRowsOf,
  type QuizBadgeAwardDefinition,
  type QuizBadgeNewWin,
} from './quiz-badge-awarding.service';
import { QUIZ_EVENT_BADGES_LOCK_SQL } from './quiz-win-badges.constants';
import { quizBadgeKeyOf } from './quiz-win-badges.contract';

/**
 * The waits before each retry of the winner recording, in milliseconds: the
 * first attempt plus three retries, spread so a short database outage passes
 * before the last one.
 */
export const QUIZ_WIN_RECORD_RETRY_DELAYS_MS: readonly number[] = [
  500, 2_000, 10_000,
];

/** Resolves after `delayMs` milliseconds. */
function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Records one winner of an event game: `$1` event, `$2` session, `$3` game
 * number, `$4` finish time, `$5` member, `$6` screen name, `$7` team name
 * (null for a solo win). A winner already recorded for the session inserts
 * nothing.
 */
export const INSERT_GAME_WINNER_SQL = `INSERT INTO "quiz_game_winners" ("event_id", "session_id", "game_number", "finished_at", "user_id", "screen_name", "team_name") VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("session_id", "user_id") DO NOTHING`;

/**
 * The members of one session that still hold their win: `$1` session. A
 * revoked winner is left out, so no badge reaches them.
 */
export const LIVE_SESSION_WINNERS_SQL = `SELECT "user_id" FROM "quiz_game_winners" WHERE "session_id" = $1 AND "revoked_at" IS NULL ORDER BY "user_id" ASC`;

/**
 * The public flag of the win snapshot: true when the event is public and
 * published at award time. `$1` event.
 */
export const EVENT_PUBLIC_AT_AWARD_SQL = `SELECT ("visibility" = 'public' AND "status" = 'published') AS "is_public" FROM "events" WHERE "id" = $1`;

interface EligibleUserRow {
  id: string;
}

interface GameSlotDefinitionRow {
  id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
}

interface EventPublicRow {
  is_public: boolean | null;
}

interface LiveWinnerRow {
  user_id: string;
}

/**
 * Pulse Live reports the end of a numbered event game through one domain
 * event. This listener records the game's winners, awards the badges attached
 * to the game to each winner who still holds the win, and sends the earned
 * notifications after the commit (contract 5.2).
 */
@Injectable()
export class QuizGameWinnersListener {
  private readonly logger = new Logger(QuizGameWinnersListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly awarding: QuizBadgeAwardingService,
  ) {}

  /**
   * Records and awards with up to three retries, waiting 500 ms, 2 s and 10 s
   * before them. Each failed attempt is logged at warn with its short Postgres
   * code only, leaving out the parameters and the error text. A failure
   * after the last attempt is logged by session id and code and swallowed,
   * so the finish that emitted the event never sees it.
   */
  @OnEvent(QUIZ_EVENT_GAME_FINISHED, { async: true })
  async onEventGameFinished(event: QuizEventGameFinishedEvent): Promise<void> {
    let newWins: QuizBadgeNewWin[] | null = null;
    let failureCode = 'unknown';
    const attemptCount = QUIZ_WIN_RECORD_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      try {
        newWins = await this.recordAndAward(event);
        break;
      } catch (error: unknown) {
        newWins = null;
        failureCode = quizshowWriteFailureCode(error);
        this.logger.warn(
          `Quiz win record attempt ${attempt} of ${attemptCount} failed for session ${event.sessionId} (${failureCode})`,
        );
        const retryDelayMs = QUIZ_WIN_RECORD_RETRY_DELAYS_MS[attempt - 1];
        if (retryDelayMs !== undefined) await waitFor(retryDelayMs);
      }
    }
    if (newWins === null) {
      this.logger.error(
        `Quiz win record failed for session ${event.sessionId} (${failureCode})`,
      );
      return;
    }
    await this.awarding.notifyNewWins(newWins);
  }

  /**
   * One transaction under the event lock: drops candidates that cannot win,
   * records the rest, then awards each badge attached to the game to each live
   * winner, badges in badge key order and winners in member id order, so the
   * award locks of two transactions are always taken in the same order.
   * Answers the wins written now, for the notifications.
   */
  async recordAndAward(
    event: QuizEventGameFinishedEvent,
  ): Promise<QuizBadgeNewWin[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(QUIZ_EVENT_BADGES_LOCK_SQL, [event.eventId]);

      const candidateUserIds = event.winners.map((winner) => winner.userId);
      const eligibleUserIds = new Set<string>();
      if (candidateUserIds.length > 0) {
        const eligibleRows = returnedRowsOf<EligibleUserRow>(
          await manager.query(ELIGIBLE_WINNER_USER_IDS_SQL, [candidateUserIds]),
        );
        for (const eligibleRow of eligibleRows)
          eligibleUserIds.add(eligibleRow.id);
      }
      for (const winner of event.winners) {
        if (!eligibleUserIds.has(winner.userId)) continue;
        await manager.query(INSERT_GAME_WINNER_SQL, [
          event.eventId,
          event.sessionId,
          event.gameNumber,
          event.finishedAt,
          winner.userId,
          winner.screenName,
          winner.teamName,
        ]);
      }

      const slotRows = returnedRowsOf<GameSlotDefinitionRow>(
        await manager.query(GAME_SLOT_DEFINITIONS_SQL, [
          event.eventId,
          event.gameNumber,
        ]),
      ).sort((first, second) =>
        quizBadgeKeyOf(first.id).localeCompare(quizBadgeKeyOf(second.id)),
      );
      if (slotRows.length === 0) return [];

      const publicRows = returnedRowsOf<EventPublicRow>(
        await manager.query(EVENT_PUBLIC_AT_AWARD_SQL, [event.eventId]),
      );
      const isEventPublic = publicRows[0]?.is_public === true;

      const liveWinnerRows = returnedRowsOf<LiveWinnerRow>(
        await manager.query(LIVE_SESSION_WINNERS_SQL, [event.sessionId]),
      ).sort((first, second) => first.user_id.localeCompare(second.user_id));

      const newWins: QuizBadgeNewWin[] = [];
      for (const slotRow of slotRows) {
        const definition: QuizBadgeAwardDefinition = {
          id: slotRow.id,
          badgeKey: slotRow.badge_key,
          nameEn: slotRow.name_en,
          namePt: slotRow.name_pt,
        };
        for (const liveWinnerRow of liveWinnerRows) {
          const newWin = await this.awarding.awardWin(manager, {
            definition,
            userId: liveWinnerRow.user_id,
            eventId: event.eventId,
            sessionId: event.sessionId,
            gameNumber: event.gameNumber,
            eventName: event.eventTitle,
            eventWasPublic: isEventPublic,
            eventWasAdultsOnly: event.isAdultsOnly,
            wonAt: event.finishedAt,
          });
          if (newWin) newWins.push(newWin);
        }
      }
      return newWins;
    });
  }
}
