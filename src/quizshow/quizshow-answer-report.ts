import type { EntityManager } from 'typeorm';
import type { QuizshowQuestionLogEntry } from './quizshow-engine-types';
import {
  QUIZSHOW_ANSWER_SNAPSHOT_TYPE,
  type QuizshowAnswerSnapshotEvidence,
  type QuizshowRoundKind,
  type QuizshowText,
} from './quizshow.contract';

interface AnswerReportRow {
  id: string;
  session_id: string;
  question_id: string;
  event_id: string;
  event_slug: string;
  text: string | null;
  received_at: Date;
  hidden_at: Date | null;
  author_screen_name: string;
  author_user_id: string;
  question_log: unknown;
  quiz_snapshot: unknown;
  is_organiser: boolean;
  reporter_joined_at: Date | null;
}

interface SnapshotQuestionLookup {
  roundKind: QuizshowRoundKind;
  questionPrompt: QuizshowText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findLogEntry(
  questionLog: unknown,
  questionId: string,
): QuizshowQuestionLogEntry | null {
  if (!Array.isArray(questionLog)) return null;
  for (const entry of questionLog as unknown[]) {
    if (isRecord(entry) && entry.questionId === questionId) {
      return entry as unknown as QuizshowQuestionLogEntry;
    }
  }
  return null;
}

function findSnapshotQuestion(
  quizSnapshot: unknown,
  questionId: string,
): SnapshotQuestionLookup | null {
  if (!isRecord(quizSnapshot) || !Array.isArray(quizSnapshot.rounds)) {
    return null;
  }
  for (const round of quizSnapshot.rounds as unknown[]) {
    if (!isRecord(round) || !Array.isArray(round.questions)) continue;
    for (const question of round.questions as unknown[]) {
      if (isRecord(question) && question.id === questionId) {
        return {
          roundKind: round.kind as QuizshowRoundKind,
          questionPrompt: question.prompt as QuizshowText,
        };
      }
    }
  }
  return null;
}

/**
 * Reads one Pulse Live answer for a report and returns the snapshot kept as
 * evidence. Returns `null` (the caller answers 404) when the answer is gone,
 * when the reporter wrote it, or when the reporter may not file: an organiser
 * of the event may always file; a player files only when they were
 * eligible for the question (not removed, joined at or before it opened) and
 * saw the answer after the reveal (never hidden, or hidden after it).
 */
export async function captureQuizshowAnswerForReport(
  manager: EntityManager,
  answerId: string,
  reporterId: string,
  now: Date,
): Promise<QuizshowAnswerSnapshotEvidence | null> {
  const rows: AnswerReportRow[] = await manager.query(
    `SELECT "answer"."id", "answer"."session_id", "answer"."question_id",
            "answer"."payload" ->> 'text' AS "text",
            "answer"."received_at", "answer"."hidden_at",
            "author"."screen_name" AS "author_screen_name",
            "author"."user_id" AS "author_user_id",
            "session"."event_id", "session"."question_log",
            "session"."quiz_snapshot", "event"."slug" AS "event_slug",
            ("event"."host_id" = $2 OR EXISTS (
               SELECT 1 FROM "event_cohosts" "cohost"
               WHERE "cohost"."event_id" = "event"."id"
                 AND "cohost"."user_id" = $2
            )) AS "is_organiser",
            (SELECT "reporter"."joined_at" FROM "quizshow_players" "reporter"
             WHERE "reporter"."session_id" = "session"."id"
               AND "reporter"."user_id" = $2
               AND "reporter"."removed_at" IS NULL) AS "reporter_joined_at"
     FROM "quizshow_answers" "answer"
     JOIN "quizshow_players" "author" ON "author"."id" = "answer"."player_id"
     JOIN "quizshow_sessions" "session" ON "session"."id" = "answer"."session_id"
     JOIN "events" "event" ON "event"."id" = "session"."event_id"
     WHERE "answer"."id" = $1`,
    [answerId, reporterId],
  );
  const row = rows[0];
  if (!row || row.author_user_id === reporterId) return null;
  if (row.text === null) return null;

  if (!row.is_organiser) {
    const logEntry = findLogEntry(row.question_log, row.question_id);
    if (!logEntry || logEntry.revealedAt === null) return null;
    if (row.reporter_joined_at === null) return null;
    if (row.reporter_joined_at.getTime() > logEntry.openedAt) return null;
    const isHiddenBeforeReveal =
      row.hidden_at !== null && row.hidden_at.getTime() <= logEntry.revealedAt;
    if (isHiddenBeforeReveal) return null;
  }

  const question = findSnapshotQuestion(row.quiz_snapshot, row.question_id);
  if (!question) return null;

  return {
    type: QUIZSHOW_ANSWER_SNAPSHOT_TYPE,
    answerId: row.id,
    sessionId: row.session_id,
    eventId: row.event_id,
    eventSlug: row.event_slug,
    roundKind: question.roundKind,
    questionPrompt: question.questionPrompt,
    text: row.text,
    authorScreenName: row.author_screen_name,
    authorUserId: row.author_user_id,
    receivedAt: row.received_at.toISOString(),
    wasHidden: row.hidden_at !== null,
    capturedAt: now.toISOString(),
  };
}
