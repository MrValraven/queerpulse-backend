import type { EntityManager } from 'typeorm';
import {
  QUIZSHOW_GAME_SNAPSHOT_TYPE,
  type QuizshowGameSnapshotEvidence,
  type QuizshowRoundKind,
  type QuizshowText,
} from './quizshow.contract';

interface GameReportRow {
  session_id: string;
  quiz_id: string;
  owner_user_id: string | null;
  event_id: string | null;
  question_log: unknown;
  quiz_snapshot: unknown;
  is_reporter_player: boolean;
}

type ShownQuestion = QuizshowGameSnapshotEvidence['shownQuestions'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Copies the two language strings of a snapshot text and nothing else. */
function textOf(value: unknown): QuizshowText {
  if (!isRecord(value)) return { en: '', pt: '' };
  return {
    en: typeof value.en === 'string' ? value.en : '',
    pt: typeof value.pt === 'string' ? value.pt : '',
  };
}

/** Option texts as the players saw them: the shuffled list when there is one. */
function shownOptionTexts(question: Record<string, unknown>): QuizshowText[] {
  const shownOptions = Array.isArray(question.shownOptions)
    ? (question.shownOptions as unknown[])
    : null;
  const options = shownOptions ?? (question.options as unknown[]);
  if (!Array.isArray(options)) return [];
  const texts: QuizshowText[] = [];
  for (const option of options) {
    if (isRecord(option)) texts.push(textOf(option.text));
  }
  return texts;
}

/** Indexes every snapshot question by id, keeping only what players saw. */
function indexSnapshotQuestions(
  quizSnapshot: unknown,
): Map<string, ShownQuestion> {
  const questionsById = new Map<string, ShownQuestion>();
  if (!isRecord(quizSnapshot) || !Array.isArray(quizSnapshot.rounds)) {
    return questionsById;
  }
  for (const round of quizSnapshot.rounds as unknown[]) {
    if (!isRecord(round) || !Array.isArray(round.questions)) continue;
    for (const question of round.questions as unknown[]) {
      if (!isRecord(question) || typeof question.id !== 'string') continue;
      questionsById.set(question.id, {
        roundKind: round.kind as QuizshowRoundKind,
        prompt: textOf(question.prompt),
        options: shownOptionTexts(question),
      });
    }
  }
  return questionsById;
}

/** Walks the question log in play order; a log entry with no snapshot question is skipped. */
function collectShownQuestions(
  questionLog: unknown,
  quizSnapshot: unknown,
): ShownQuestion[] {
  if (!Array.isArray(questionLog)) return [];
  const questionsById = indexSnapshotQuestions(quizSnapshot);
  const shownQuestions: ShownQuestion[] = [];
  for (const entry of questionLog as unknown[]) {
    if (!isRecord(entry) || typeof entry.questionId !== 'string') continue;
    const question = questionsById.get(entry.questionId);
    if (question) shownQuestions.push(question);
  }
  return shownQuestions;
}

function snapshotTitle(quizSnapshot: unknown): string {
  return isRecord(quizSnapshot) && typeof quizSnapshot.title === 'string'
    ? quizSnapshot.title
    : '';
}

/**
 * Reads one Pulse Live game session for a report and returns the snapshot
 * kept as evidence. Returns `null` (the caller answers 404) when the session
 * is unknown, when it belongs to an event, or when the reporter has no player
 * row in it. A removed player keeps their row and may file. The snapshot holds
 * only the questions the session had shown, with the prompt and the option
 * texts players saw; the answer key stays out of it.
 */
export async function captureQuizshowGameForReport(
  manager: EntityManager,
  sessionId: string,
  reporterId: string,
  now: Date,
): Promise<QuizshowGameSnapshotEvidence | null> {
  const rows: GameReportRow[] = await manager.query(
    `SELECT "session"."id" AS "session_id", "quiz"."id" AS "quiz_id",
            "quiz"."owner_user_id", "quiz"."event_id",
            "session"."question_log", "session"."quiz_snapshot",
            EXISTS (
              SELECT 1 FROM "quizshow_players" "reporter"
              WHERE "reporter"."session_id" = "session"."id"
                AND "reporter"."user_id" = $2
            ) AS "is_reporter_player"
     FROM "quizshow_sessions" "session"
     JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "session"."quiz_id"
     WHERE "session"."id" = $1
       AND "quiz"."owner_user_id" IS NOT NULL`,
    [sessionId, reporterId],
  );
  const row = rows[0];
  if (!row || row.owner_user_id === null || row.event_id !== null) {
    return null;
  }
  if (!row.is_reporter_player) return null;

  return {
    type: QUIZSHOW_GAME_SNAPSHOT_TYPE,
    sessionId: row.session_id,
    gameId: row.quiz_id,
    quizTitle: snapshotTitle(row.quiz_snapshot),
    ownerUserId: row.owner_user_id,
    shownQuestions: collectShownQuestions(row.question_log, row.quiz_snapshot),
    capturedAt: now.toISOString(),
  };
}
