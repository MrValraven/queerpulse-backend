import { AdvancedConsoleLogger, type QueryRunner } from 'typeorm';

/**
 * Tables whose bound values are private member content: creator and listing
 * wizard drafts and the member drafts table (`draft`, from
 * drafts/entities/draft.entity.ts) carry the whole draft payload, and the quiz
 * show tables carry
 * players' answers, votes and team names, and the quiz, round, question and
 * session tables carry game titles and question text. A failed or slow query
 * on any of
 * them logs its SQL text, its error and its timing as usual, with the
 * parameters left out.
 */
export const PRIVATE_PARAMETER_TABLES = [
  'creator_drafts',
  'listing_drafts',
  'draft',
  'quizshow_answers',
  'quizshow_votes',
  'quizshow_players',
  'quizshow_teams',
  'quizshow_quizzes',
  'quizshow_rounds',
  'quizshow_questions',
  'quizshow_sessions',
] as const;

/**
 * Matches a whole table name in any letter case. A name with an underscore
 * matches quoted or bare. A one-word name such as `draft` is also a status
 * value (`'draft'`) in many unrelated queries, so it matches only as a quoted
 * identifier, the form TypeORM writes.
 */
const PRIVATE_PARAMETER_TABLE_PATTERN = new RegExp(
  PRIVATE_PARAMETER_TABLES.map((table) =>
    table.includes('_') ? `\\b${table}\\b` : `"${table}"`,
  ).join('|'),
  'i',
);

export function touchesPrivateParameterTable(query: string): boolean {
  return (
    typeof query === 'string' && PRIVATE_PARAMETER_TABLE_PATTERN.test(query)
  );
}

function parametersFit(
  query: string,
  parameters: unknown[] | undefined,
): unknown[] | undefined {
  return touchesPrivateParameterTable(query) ? undefined : parameters;
}

/**
 * TypeORM's default logger (the one `logging` picks when no `logger` is set),
 * with one change: the `-- PARAMETERS:` comment is dropped from a logged query
 * that touches a table in `PRIVATE_PARAMETER_TABLES`. Every other line, and
 * every query on any other table, logs exactly as before.
 */
export class PrivateParametersLogger extends AdvancedConsoleLogger {
  logQuery(
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    super.logQuery(query, parametersFit(query, parameters), queryRunner);
  }

  logQueryError(
    error: string,
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    super.logQueryError(
      error,
      query,
      parametersFit(query, parameters),
      queryRunner,
    );
  }

  logQuerySlow(
    time: number,
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    super.logQuerySlow(
      time,
      query,
      parametersFit(query, parameters),
      queryRunner,
    );
  }
}
