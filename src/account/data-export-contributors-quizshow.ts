import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface QuizshowText {
  en: string;
  pt: string;
}

interface QuizshowPlayExportRow {
  player_id: string;
  event_title: string | null;
  event_slug: string | null;
  quiz_title: string;
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
  eventTitle: string | null;
  eventSlug: string | null;
  quizTitle: string;
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
              ("session"."quiz_snapshot" ->> 'title') AS "quiz_title",
              "session"."started_at" AS "started_at",
              "player"."screen_name" AS "screen_name",
              "team"."name" AS "team_name",
              "player"."score" AS "score",
              ("player"."removed_at" IS NOT NULL) AS "is_removed",
              "session"."quiz_snapshot" AS "quiz_snapshot"
         FROM "quizshow_players" "player"
         JOIN "quizshow_sessions" "session" ON "session"."id" = "player"."session_id"
         LEFT JOIN "events" "event" ON "event"."id" = "session"."event_id"
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
        quizTitle: row.quiz_title,
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

interface QuizshowGameExportRow {
  id: string;
  title: string;
  is_adults_only: boolean;
  languages: string;
  screen_language: string;
  created_at: Date;
  updated_at: Date;
}

interface QuizshowRoundExportRow {
  id: string;
  quiz_id: string;
  kind: string;
  title_en: string;
  title_pt: string;
  content_label: string;
}

interface QuizshowQuestionExportRow {
  round_id: string;
  type: string;
  prompt_en: string;
  prompt_pt: string;
  media_ref: string | null;
  options: unknown;
  answer: unknown;
  accepted_answers: unknown;
}

export interface QuizshowGameQuestionExport {
  type: string;
  prompt: QuizshowText;
  options: unknown;
  answer: unknown;
  acceptedAnswers: unknown;
  mediaRef: string | null;
}

export interface QuizshowGameRoundExport {
  title: QuizshowText;
  kind: string;
  contentLabel: string;
  questions: QuizshowGameQuestionExport[];
}

export interface QuizshowGameExport {
  title: string;
  isAdultsOnly: boolean;
  languages: string;
  screenLanguage: string;
  createdAt: string;
  updatedAt: string;
  rounds: QuizshowGameRoundExport[];
}

/**
 * `events` -> `quizshowGames` (Pulse Live): one row per game the member owns,
 * with its rounds and questions in play order. Three raw queries grouped in
 * memory, so `AccountModule` registers no entity.
 */
@Injectable()
export class QuizshowGamesExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'quizshowGames';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<QuizshowGameExport[]> {
    const gameRows: QuizshowGameExportRow[] = await this.dataSource.query(
      `SELECT "game"."id" AS "id",
              "game"."title" AS "title",
              "game"."is_adults_only" AS "is_adults_only",
              "game"."languages" AS "languages",
              "game"."screen_language" AS "screen_language",
              "game"."created_at" AS "created_at",
              "game"."updated_at" AS "updated_at"
         FROM "quizshow_quizzes" "game"
        WHERE "game"."owner_user_id" = $1
        ORDER BY "game"."created_at" ASC, "game"."id" ASC`,
      [userId],
    );
    if (gameRows.length === 0) return [];
    const gameIds = gameRows.map((row) => row.id);

    const roundRows: QuizshowRoundExportRow[] = await this.dataSource.query(
      `SELECT "round"."id" AS "id",
              "round"."quiz_id" AS "quiz_id",
              "round"."kind" AS "kind",
              "round"."title_en" AS "title_en",
              "round"."title_pt" AS "title_pt",
              "round"."content_label" AS "content_label"
         FROM "quizshow_rounds" "round"
        WHERE "round"."quiz_id" = ANY($1::uuid[])
        ORDER BY "round"."position" ASC`,
      [gameIds],
    );
    const roundIds = roundRows.map((row) => row.id);
    const questionRows: QuizshowQuestionExportRow[] =
      roundIds.length === 0
        ? []
        : await this.dataSource.query(
            `SELECT "question"."round_id" AS "round_id",
                    "question"."type" AS "type",
                    "question"."prompt_en" AS "prompt_en",
                    "question"."prompt_pt" AS "prompt_pt",
                    "question"."media_ref" AS "media_ref",
                    "question"."options" AS "options",
                    "question"."answer" AS "answer",
                    "question"."accepted_answers" AS "accepted_answers"
               FROM "quizshow_questions" "question"
              WHERE "question"."round_id" = ANY($1::uuid[])
              ORDER BY "question"."position" ASC`,
            [roundIds],
          );
    const roundsByGame = groupBy(roundRows, (row) => row.quiz_id);
    const questionsByRound = groupBy(questionRows, (row) => row.round_id);

    return gameRows.map((row) => ({
      title: row.title,
      isAdultsOnly: row.is_adults_only,
      languages: row.languages,
      screenLanguage: row.screen_language,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      rounds: (roundsByGame.get(row.id) ?? []).map((round) => ({
        title: { en: round.title_en, pt: round.title_pt },
        kind: round.kind,
        contentLabel: round.content_label,
        questions: (questionsByRound.get(round.id) ?? []).map((question) => ({
          type: question.type,
          prompt: { en: question.prompt_en, pt: question.prompt_pt },
          options: question.options,
          answer: question.answer,
          acceptedAnswers: question.accepted_answers,
          mediaRef: question.media_ref,
        })),
      })),
    }));
  }
}
