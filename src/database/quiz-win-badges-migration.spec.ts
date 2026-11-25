// Lives beside the migration runner in `src/database`, outside
// `src/migrations`: the TypeORM CLI and `DatabaseModule` both require every
// `src/migrations/*.ts` file in development, and requiring a spec there throws
// `describe is not defined` before any migration runs.
//
// The spec runs the migration class against a recording query runner and
// compares each statement with the plan text, whitespace collapsed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryRunner } from 'typeorm';
import { AddQuizWinBadges1840910000000 } from '../migrations/1840910000000-AddQuizWinBadges';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '1840910000000-AddQuizWinBadges.ts',
);

/** `sql` with whitespace runs folded and the space inside parentheses dropped. */
function collapsed(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim();
}

/** The collapsed SQL of every `query` call one direction makes, in order. */
async function statementsOf(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn().mockResolvedValue(undefined);
  await new AddQuizWinBadges1840910000000()[direction]({
    query,
  } as unknown as QueryRunner);
  return query.mock.calls.map(([sql]: [string]) => collapsed(sql));
}

describe('AddQuizWinBadges1840910000000', () => {
  let upStatements: string[];
  let downStatements: string[];

  beforeAll(async () => {
    upStatements = await statementsOf('up');
    downStatements = await statementsOf('down');
  });

  it('opens with the review banner', () => {
    expect(readFileSync(MIGRATION_PATH, 'utf8').split('\n')[0]).toBe(
      '// DO NOT RUN: authored for review only; the maintainer runs migrations.',
    );
  });

  it('carries the ledger name', () => {
    expect(new AddQuizWinBadges1840910000000().name).toBe(
      'AddQuizWinBadges1840910000000',
    );
  });

  it('runs the 22 up statements in order', () => {
    expect(upStatements).toHaveLength(22);
    expect(upStatements[2]).toBe(
      'CREATE UNIQUE INDEX "UQ_quiz_badge_definitions_name_en" ON "quiz_badge_definitions" (lower("name_en"))',
    );
    expect(upStatements[19]).toBe(
      'ALTER TABLE "quizshow_sessions" ADD "event_game_number" integer',
    );
    expect(upStatements[21]).toBe(
      'CREATE UNIQUE INDEX "UQ_quizshow_sessions_event_game_number" ON "quizshow_sessions" ("event_id", "event_game_number") WHERE "event_game_number" IS NOT NULL',
    );
  });

  it('ties every badge key to its definition id', () => {
    expect(upStatements[0]).toContain(
      `CONSTRAINT "CHK_quiz_badge_definitions_badge_key" CHECK ("badge_key" = 'quiz:' || "id"::text)`,
    );
  });

  it('keeps wins and slots when a definition is in use and cascades a member erasure', () => {
    expect(upStatements[5]).toContain(
      'REFERENCES "quiz_badge_definitions"("id") ON DELETE RESTRICT',
    );
    expect(upStatements[14]).toContain(
      'REFERENCES "quiz_badge_definitions"("id") ON DELETE RESTRICT',
    );
    expect(upStatements[14]).toContain(
      'REFERENCES "users"("id") ON DELETE CASCADE',
    );
    expect(upStatements[9]).toContain(
      'CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))',
    );
  });

  it('adds no enum label and no IF NOT EXISTS', () => {
    expect(upStatements.join(' ')).not.toContain('IF NOT EXISTS');
    expect(upStatements.join(' ')).not.toContain('ALTER TYPE');
  });

  it('clears quiz award rows first on down', () => {
    expect(downStatements[0]).toBe(
      `DELETE FROM "recognition_awards" WHERE "badge_key" LIKE 'quiz:%'`,
    );
    expect(downStatements).toHaveLength(8);
  });
});
