import type { EntityManager } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import { QUIZSHOW_LIMITS, type QuizshowEventDetail } from './quizshow.contract';

/**
 * Raw reads for the event detail. They use table names only, so `EventsService`
 * takes no new provider and no entity import.
 */

export const EVENT_HAS_ADULTS_ROUNDS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM "quizshow_rounds" "round"
    INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "round"."quiz_id"
    WHERE "quiz"."event_id" = $1
      AND "round"."content_label" = 'adults'
  ) AS "exists"
`;

/**
 * $1 event id, $2 host user id (null when the event has no host), $3 viewer id,
 * $4 viewer is an organiser, $5 viewer holds a going RSVP, $6 idle cutoff
 * (now minus `abandonAfterMs`).
 */
export const EVENT_QUIZSHOW_SUMMARY_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM "quizshow_quizzes" "quiz" WHERE "quiz"."event_id" = $1
    ) AS "has_quiz",
    "open_session"."join_code" AS "join_code",
    COALESCE("open_session"."last_host_command_at" <= $6::timestamptz, false) AS "is_idle",
    (
      NOT $4::boolean
      AND (
      EXISTS (
        SELECT 1 FROM "event_bans" "ban"
        WHERE "ban"."event_id" = $1 AND "ban"."user_id" = $3
      )
      OR EXISTS (
        SELECT 1 FROM "blocks" "block"
        WHERE $2::uuid IS NOT NULL
          AND (
            ("block"."blocker_id" = $3 AND "block"."blocked_id" = $2::uuid)
            OR ("block"."blocker_id" = $2::uuid AND "block"."blocked_id" = $3)
          )
      )
      )
    ) AS "is_barred",
    EXISTS (
      SELECT 1
      FROM "quizshow_results" "result"
      INNER JOIN "quizshow_sessions" "kept_session" ON "kept_session"."id" = "result"."session_id"
      WHERE "kept_session"."event_id" = $1
        AND "kept_session"."results_kept" = true
        AND (
          $4::boolean
          OR $5::boolean
          OR EXISTS (
            SELECT 1 FROM "quizshow_players" "player"
            WHERE "player"."session_id" = "kept_session"."id"
              AND "player"."user_id" = $3
              AND "player"."removed_at" IS NULL
          )
        )
    ) AS "has_viewable_results"
  FROM (SELECT 1) AS "anchor"
  LEFT JOIN LATERAL (
    SELECT "session"."join_code", "session"."last_host_command_at"
    FROM "quizshow_sessions" "session"
    WHERE "session"."event_id" = $1
      AND "session"."status" IN ('lobby', 'running', 'paused')
    LIMIT 1
  ) AS "open_session" ON true
`;

interface EventQuizshowSummaryRow {
  has_quiz: boolean;
  join_code: string | null;
  is_idle: boolean;
  is_barred: boolean;
  has_viewable_results: boolean;
}

export interface EventQuizshowSummaryInput {
  eventId: string;
  hostUserId: string | null;
  viewerId: string;
  isOrganizer: boolean;
  hasGoingRsvp: boolean;
  now: Date;
}

export async function eventHasAdultsRounds(
  manager: EntityManager,
  eventId: string,
): Promise<boolean> {
  const rows: { exists: boolean }[] = await manager.query(
    EVENT_HAS_ADULTS_ROUNDS_SQL,
    [eventId],
  );
  return rows[0]?.exists === true;
}

export async function readEventQuizshowSummary(
  manager: EntityManager,
  input: EventQuizshowSummaryInput,
): Promise<QuizshowEventDetail | null> {
  if (!isFeatureLaunched('quizshow')) {
    return null;
  }
  const idleCutoff = new Date(
    input.now.getTime() - QUIZSHOW_LIMITS.abandonAfterMs,
  );
  const rows: EventQuizshowSummaryRow[] = await manager.query(
    EVENT_QUIZSHOW_SUMMARY_SQL,
    [
      input.eventId,
      input.hostUserId,
      input.viewerId,
      input.isOrganizer,
      input.hasGoingRsvp,
      idleCutoff,
    ],
  );
  const row = rows[0];
  if (!row) {
    return { hasQuiz: false, liveSessionCode: null, hasResults: false };
  }
  const isCodeHidden = row.is_idle || row.is_barred;
  return {
    hasQuiz: row.has_quiz,
    liveSessionCode: isCodeHidden ? null : row.join_code,
    // A barred going guest meets a 404 on the results read, so no card shows.
    hasResults: row.has_viewable_results && !row.is_barred,
  };
}
