import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface QuizshowText {
  en: string;
  pt: string;
}

interface QuizshowPlayExportRow {
  player_id: string;
  event_title: string;
  event_slug: string;
  started_at: Date;
  screen_name: string;
  team_name: string | null;
  score: number;
  is_removed: boolean;
  quiz_snapshot: unknown;
}

interface QuizshowAnswerExportRow {
  player_id: string;
  question_id: string;
  payload: unknown;
  points_awarded: number;
  received_at: Date;
}

interface QuizshowVoteExportRow {
  voter_player_id: string;
  question_id: string;
  is_for_truth: boolean;
  created_at: Date;
}

export interface QuizshowAnswerExport {
  questionPrompt: QuizshowText | null;
  answer: unknown;
  pointsAwarded: number;
  receivedAt: string;
}

export interface QuizshowVoteExport {
  questionPrompt: QuizshowText | null;
  votedForTruth: boolean;
  votedAt: string;
}

export interface QuizshowPlayExport {
  eventTitle: string;
  eventSlug: string;
  startedAt: string;
  screenName: string;
  teamName: string | null;
  score: number;
  wasRemoved: boolean;
  answers: QuizshowAnswerExport[];
  votes: QuizshowVoteExport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the question prompts out of a session's frozen quiz
 * (`rounds[].questions[]`), keyed by question id. A snapshot of any other
 * shape yields no prompts, so the export falls back to null.
 */
function promptsByQuestionId(quizSnapshot: unknown): Map<string, QuizshowText> {
  const prompts = new Map<string, QuizshowText>();
  if (!isRecord(quizSnapshot) || !Array.isArray(quizSnapshot.rounds)) {
    return prompts;
  }
  for (const round of quizSnapshot.rounds as unknown[]) {
    if (!isRecord(round) || !Array.isArray(round.questions)) continue;
    for (const question of round.questions as unknown[]) {
      if (!isRecord(question) || typeof question.id !== 'string') continue;
      const prompt = question.prompt;
      if (
        isRecord(prompt) &&
        typeof prompt.en === 'string' &&
        typeof prompt.pt === 'string'
      ) {
        prompts.set(question.id, { en: prompt.en, pt: prompt.pt });
      }
    }
  }
  return prompts;
}

function groupBy<Row>(
  rows: Row[],
  keyOf: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/**
 * `events` -> `quizshowPlays` (Pulse Live): one row per live game session the
 * member played, removed seats included, with the member's own answers and
 * votes. The question is named from the session's frozen quiz. A vote records
 * only whether it went to the truth; another member's answer text stays out.
 * Answers and votes age out 30 days after the session, so an older session
 * exports empty lists. Raw SQL, so `AccountModule` registers no entity.
 */
@Injectable()
export class QuizshowPlaysExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'quizshowPlays';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<QuizshowPlayExport[]> {
    const playRows: QuizshowPlayExportRow[] = await this.dataSource.query(
      `SELECT "player"."id" AS "player_id",
              "event"."title" AS "event_title",
              "event"."slug" AS "event_slug",
              "session"."started_at" AS "started_at",
              "player"."screen_name" AS "screen_name",
              "team"."name" AS "team_name",
              "player"."score" AS "score",
              ("player"."removed_at" IS NOT NULL) AS "is_removed",
              "session"."quiz_snapshot" AS "quiz_snapshot"
         FROM "quizshow_players" "player"
         JOIN "quizshow_sessions" "session" ON "session"."id" = "player"."session_id"
         JOIN "events" "event" ON "event"."id" = "session"."event_id"
         LEFT JOIN "quizshow_teams" "team" ON "team"."id" = "player"."team_id"
        WHERE "player"."user_id" = $1
        ORDER BY "session"."started_at" ASC, "player"."id" ASC`,
      [userId],
    );
    if (playRows.length === 0) return [];
    const playerIds = playRows.map((row) => row.player_id);

    const answerRows: QuizshowAnswerExportRow[] = await this.dataSource.query(
      `SELECT "answer"."player_id" AS "player_id",
              "answer"."question_id" AS "question_id",
              "answer"."payload" AS "payload",
              "answer"."points_awarded" AS "points_awarded",
              "answer"."received_at" AS "received_at"
         FROM "quizshow_answers" "answer"
        WHERE "answer"."player_id" = ANY($1::uuid[])
        ORDER BY "answer"."received_at" ASC, "answer"."id" ASC`,
      [playerIds],
    );
    const voteRows: QuizshowVoteExportRow[] = await this.dataSource.query(
      `SELECT "vote"."voter_player_id" AS "voter_player_id",
              "vote"."question_id" AS "question_id",
              ("vote"."answer_id" IS NULL) AS "is_for_truth",
              "vote"."created_at" AS "created_at"
         FROM "quizshow_votes" "vote"
        WHERE "vote"."voter_player_id" = ANY($1::uuid[])
        ORDER BY "vote"."created_at" ASC, "vote"."id" ASC`,
      [playerIds],
    );
    const answersByPlayer = groupBy(answerRows, (row) => row.player_id);
    const votesByPlayer = groupBy(voteRows, (row) => row.voter_player_id);

    return playRows.map((row) => {
      const prompts = promptsByQuestionId(row.quiz_snapshot);
      return {
        eventTitle: row.event_title,
        eventSlug: row.event_slug,
        startedAt: row.started_at.toISOString(),
        screenName: row.screen_name,
        teamName: row.team_name,
        score: row.score,
        wasRemoved: row.is_removed,
        answers: (answersByPlayer.get(row.player_id) ?? []).map((answer) => ({
          questionPrompt: prompts.get(answer.question_id) ?? null,
          answer: answer.payload,
          pointsAwarded: answer.points_awarded,
          receivedAt: answer.received_at.toISOString(),
        })),
        votes: (votesByPlayer.get(row.player_id) ?? []).map((vote) => ({
          questionPrompt: prompts.get(vote.question_id) ?? null,
          votedForTruth: vote.is_for_truth,
          votedAt: vote.created_at.toISOString(),
        })),
      };
    });
  }
}
