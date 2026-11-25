import type { DataSource, EntityManager } from 'typeorm';
import {
  QUIZSHOW_LIMITS,
  type QuizshowContentLabel,
  type QuizshowImportRoundRef,
  type QuizshowImportSource,
  type QuizshowRoundKind,
} from './quizshow.contract';

/**
 * Round count, question count, the adults flag and every row of the quiz
 * aliased `"quiz"`. The rows feed "Add rounds from" (contract 6.28): a save
 * writes positions from 0 without gaps, so a row's position is its index. A
 * wheel row carries its stored slice count (null for Auto, for a stored value
 * that is not a JSON number, and on every other row), so the FE checklist
 * selects the same slice range the server adds.
 */
const QUIZ_COUNT_COLUMNS = `
    (
      SELECT COUNT(*)::int FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
        AND "round"."kind"::text <> 'wheel'
    ) AS "round_count",
    (
      SELECT COUNT(*)::int
      FROM "quizshow_questions" "question"
      INNER JOIN "quizshow_rounds" "round" ON "round"."id" = "question"."round_id"
      WHERE "round"."quiz_id" = "quiz"."id"
    ) AS "question_count",
    EXISTS (
      SELECT 1 FROM "quizshow_rounds" "round"
      WHERE "round"."quiz_id" = "quiz"."id"
        AND "round"."content_label" = 'adults'
    ) AS "has_adults_rounds",
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'roundIndex', "listed_round"."position",
          'kind', "listed_round"."kind",
          'titleEn', "listed_round"."title_en",
          'titlePt', "listed_round"."title_pt",
          'questionCount', (
            SELECT COUNT(*)::int FROM "quizshow_questions" "listed_question"
            WHERE "listed_question"."round_id" = "listed_round"."id"
          ),
          'sliceCount', CASE
            WHEN "listed_round"."kind"::text = 'wheel'
              AND jsonb_typeof("listed_round"."settings"->'sliceCount') = 'number'
              THEN ("listed_round"."settings"->>'sliceCount')::numeric::int
            ELSE NULL
          END,
          'contentLabel', "listed_round"."content_label"
        )
        ORDER BY "listed_round"."position"
      )
      FROM "quizshow_rounds" "listed_round"
      WHERE "listed_round"."quiz_id" = "quiz"."id"
    ), '[]'::jsonb) AS "rounds"
`;

/** $1 excluded slug (nullable), $2 caller id, $3 series id (nullable), $4 limit. */
export const IMPORT_SOURCES_SQL = `
  SELECT
    "event"."slug" AS "event_slug",
    "event"."title" AS "event_title",
    "event"."start_at" AS "start_at",
    "quiz"."title" AS "quiz_title",
    ${QUIZ_COUNT_COLUMNS},
    COALESCE($3::uuid IS NOT NULL AND "event"."series_id" = $3::uuid, false) AS "is_same_series"
  FROM "events" "event"
  INNER JOIN "quizshow_quizzes" "quiz" ON "quiz"."event_id" = "event"."id"
  WHERE ($1::text IS NULL OR "event"."slug" <> $1)
    AND (
      "event"."host_id" = $2
      OR EXISTS (
        SELECT 1 FROM "event_cohosts" "cohost"
        WHERE "cohost"."event_id" = "event"."id" AND "cohost"."user_id" = $2
      )
    )
  ORDER BY "event"."start_at" DESC, "event"."id"
  LIMIT $4
`;

/** $1 owner id, $2 excluded game id (nullable), $3 limit: the owner's games, last edited first. */
export const GAME_IMPORT_SOURCES_SQL = `
  SELECT
    "quiz"."id" AS "game_id",
    "quiz"."title" AS "quiz_title",
    ${QUIZ_COUNT_COLUMNS}
  FROM "quizshow_quizzes" "quiz"
  WHERE "quiz"."owner_user_id" = $1
    AND ($2::uuid IS NULL OR "quiz"."id" <> $2::uuid)
  ORDER BY "quiz"."updated_at" DESC, "quiz"."id"
  LIMIT $3
`;

/** One element of the `rounds` jsonb array. */
interface ListedRoundRow {
  roundIndex: number;
  kind: QuizshowRoundKind;
  titleEn: string;
  titlePt: string;
  questionCount: number;
  /** Wheel rows: the stored slice count, null for Auto; null on every other row. */
  sliceCount: number | null;
  /** Absent on a row written by an older query: maps to 'none'. */
  contentLabel?: QuizshowContentLabel | null;
}

interface QuizCountRow {
  quiz_title: string;
  round_count: number;
  question_count: number;
  has_adults_rounds: boolean;
  rounds: ListedRoundRow[] | null;
}

interface EventImportSourceRow extends QuizCountRow {
  event_slug: string;
  event_title: string;
  start_at: Date | string;
  is_same_series: boolean;
}

interface GameImportSourceRow extends QuizCountRow {
  game_id: string;
}

/** A data source or the manager of an open transaction. */
export type QuizshowQueryable = DataSource | EntityManager;

function runQuery<Row>(
  queryable: QuizshowQueryable,
  sql: string,
  parameters: unknown[],
): Promise<Row[]> {
  const runner: Pick<EntityManager, 'query'> = queryable;
  return runner.query<Row[]>(sql, parameters);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toRoundRefs(
  rounds: ListedRoundRow[] | null,
): QuizshowImportRoundRef[] {
  return (rounds ?? []).map((round) => ({
    roundIndex: round.roundIndex,
    kind: round.kind,
    title: { en: round.titleEn, pt: round.titlePt },
    questionCount: round.questionCount,
    sliceCount: round.kind === 'wheel' ? (round.sliceCount ?? null) : null,
    contentLabel: round.contentLabel ?? 'none',
  }));
}

/** Events the caller hosts or co-hosts that hold a quiz, newest start first. */
export async function listOrganisedEventSources(
  queryable: QuizshowQueryable,
  input: {
    userId: string;
    excludeEventSlug: string | null;
    seriesId: string | null;
  },
): Promise<QuizshowImportSource[]> {
  const rows = await runQuery<EventImportSourceRow>(
    queryable,
    IMPORT_SOURCES_SQL,
    [
      input.excludeEventSlug,
      input.userId,
      input.seriesId,
      QUIZSHOW_LIMITS.importSourcesMax,
    ],
  );
  return rows.map((row) => ({
    kind: 'event',
    eventSlug: row.event_slug,
    eventTitle: row.event_title,
    startAt: toIsoString(row.start_at),
    gameId: null,
    quizTitle: row.quiz_title,
    roundCount: row.round_count,
    questionCount: row.question_count,
    hasAdultsRounds: row.has_adults_rounds,
    isSameSeries: row.is_same_series,
    rounds: toRoundRefs(row.rounds),
  }));
}

/** Games the caller owns, last edited first; a game never shares a series. */
export async function listOwnedGameSources(
  queryable: QuizshowQueryable,
  input: { userId: string; excludeGameId: string | null },
): Promise<QuizshowImportSource[]> {
  const rows = await runQuery<GameImportSourceRow>(
    queryable,
    GAME_IMPORT_SOURCES_SQL,
    [input.userId, input.excludeGameId, QUIZSHOW_LIMITS.importSourcesMax],
  );
  return rows.map((row) => ({
    kind: 'game',
    eventSlug: null,
    eventTitle: null,
    startAt: null,
    gameId: row.game_id,
    quizTitle: row.quiz_title,
    roundCount: row.round_count,
    questionCount: row.question_count,
    hasAdultsRounds: row.has_adults_rounds,
    isSameSeries: false,
    rounds: toRoundRefs(row.rounds),
  }));
}
