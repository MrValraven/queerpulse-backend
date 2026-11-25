// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { AddQuizshowReportSubject1836000000000 } from '../migrations/1836000000000-AddQuizshowReportSubject';
import { AddQuizshow1836000100000 } from '../migrations/1836000100000-AddQuizshow';
import { AddQuizshowGameReportSubject1837000000000 } from '../migrations/1837000000000-AddQuizshowGameReportSubject';
import { AddQuizshowGames1837000100000 } from '../migrations/1837000100000-AddQuizshowGames';
import { AddQuizshowTemplates1837900000000 } from '../migrations/1837900000000-AddQuizshowTemplates';
import { AddQuizshowWheel1840000000000 } from '../migrations/1840000000000-AddQuizshowWheel';
import { AddQuizshowWheelTemplates1840100000000 } from '../migrations/1840100000000-AddQuizshowWheelTemplates';
import { QuizshowLiveV21840900000000 } from '../migrations/1840900000000-QuizshowLiveV2';
import { QUIZSHOW_TEMPLATE_SEEDS_1837900000000 } from '../migrations/data/quizshow-templates-1837900000000.seed';
import { QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000 } from '../migrations/data/quizshow-wheel-templates-1840100000000.seed';

/**
 * Pulse Live migrations on real Postgres, in ledger order: the two
 * `1836000*` migrations as they ran in production, then the two `1837000*`
 * forward migrations that add games without an event, then the
 * `1837900000000` templates migration with its five seeded drafts, then the
 * `1840000000000` wheel migration that appends `wheel` to the round kind
 * enum, then the `1840100000000` wheel templates migration with its five
 * seeded drafts (up and down inside the templates block), then the
 * `1840900000000` live v2 migration (inside the templates block, because it
 * adds template columns). Skipped unless
 * `QUIZSHOW_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   QUIZSHOW_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/quizshow_test \
 *     npx jest src/database/quizshow-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.QUIZSHOW_MIGRATIONS_DATABASE_URL;

interface RecordedStatement {
  statement: string;
  parameters: unknown[] | undefined;
}

/** Every statement and parameter list `up` sends, in order, with no database. */
async function recordedStatementsOf(
  migration: QuizshowLiveV21840900000000,
): Promise<RecordedStatement[]> {
  const statements: RecordedStatement[] = [];
  const recordingRunner = {
    query: (statement: string, parameters?: unknown[]): Promise<void> => {
      statements.push({ statement, parameters });
      return Promise.resolve();
    },
  } as unknown as QueryRunner;
  await migration.up(recordingRunner);
  return statements;
}

describe('the live v2 seeded closest rows', () => {
  it('name a closest question of a frozen seed by template, round and question position, with its seeded value', async () => {
    const statements = await recordedStatementsOf(
      new QuizshowLiveV21840900000000(),
    );
    const seededUpdate = statements.find(({ statement }) =>
      statement.includes('unnest($8::text[])'),
    );
    const parameters = seededUpdate?.parameters as
      [string[], number[], number[], number[], string[], number[]] | undefined;
    if (parameters === undefined) {
      throw new Error('Expected the seeded template update in step 6');
    }
    const [templateIds, roundPositions, questionPositions, values, modes] =
      parameters;
    expect(templateIds).toHaveLength(14);
    const seeds = [
      ...QUIZSHOW_TEMPLATE_SEEDS_1837900000000,
      ...QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000,
    ];
    templateIds.forEach((templateId, rowIndex) => {
      const seed = seeds.find((candidate) => candidate.id === templateId);
      const question = seed?.quiz.rounds[roundPositions[rowIndex] ?? -1]
        ?.questions[questionPositions[rowIndex] ?? -1] as
        { type: string; answer: { value: number } } | undefined;
      expect(question?.type).toBe('closest_number');
      expect(question?.answer.value).toBe(values[rowIndex]);
      // A year takes its band from the year rule, never from this list.
      const value = values[rowIndex] ?? 0;
      expect(value >= 1000 && value <= 2100).toBe(false);
    });
    expect(new Set(modes)).toEqual(new Set(['exact', 'percent']));
  });
});
const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

const ORGANISER_USER = 'd8000000-0000-4000-8000-000000000001';
const PLAYER_USER = 'd8000000-0000-4000-8000-000000000002';
const EVENT_ID = 'd8100000-0000-4000-8000-000000000001';
const OTHER_EVENT_ID = 'd8100000-0000-4000-8000-000000000002';
const QUIZ_ID = 'd8200000-0000-4000-8000-000000000001';
const OTHER_QUIZ_ID = 'd8200000-0000-4000-8000-000000000002';

const QUIZSHOW_TABLES = [
  'quizshow_quizzes',
  'quizshow_rounds',
  'quizshow_questions',
  'quizshow_sessions',
  'quizshow_teams',
  'quizshow_players',
  'quizshow_answers',
  'quizshow_votes',
  'quizshow_results',
  'quizshow_lobby_opens',
];

function refuseUnlessTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop and synchronize "${databaseName}": the name must end in _test`,
    );
  }
}

describeWithDatabase('Pulse Live migrations on real Postgres', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  const labelsOf = async (typeName: string): Promise<string[]> => {
    const rows: { label: string }[] = await dataSource.query(
      `SELECT unnest(enum_range(NULL::"${typeName}"))::text AS "label"`,
    );
    return rows.map((row) => row.label);
  };

  const countOf = async (tableName: string): Promise<number> => {
    const rows: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "${tableName}"`,
    );
    return rows[0]?.count ?? 0;
  };

  const insertSession = async (
    sessionId: string,
    eventId: string | null,
    quizId: string,
    joinCode: string,
    status: string,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO "quizshow_sessions"
         ("id", "quiz_id", "event_id", "status", "join_code", "play_mode", "cursor", "quiz_snapshot", "started_at", "last_host_command_at")
       VALUES ($1, $2, $3, $4, $5, 'solo', '{}', '{}', now(), now())`,
      [sessionId, quizId, eventId, status, joinCode],
    );
  };

  const insertTeam = (
    sessionId: string,
    name: string,
    colorKey: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "quizshow_teams" ("session_id", "name", "color_key") VALUES ($1, $2, $3)`,
      [sessionId, name, colorKey],
    );

  const insertQuiz = (quizId: string, eventId: string): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "quizshow_quizzes" ("id", "event_id", "title", "languages", "screen_language", "created_by_user_id", "updated_at")
       VALUES ($1, $2, 'Friday quiz', 'both', 'en', $3, now())`,
      [quizId, eventId, ORGANISER_USER],
    );

  const insertGameQuiz = (
    quizId: string,
    ownerUserId: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO "quizshow_quizzes" ("id", "owner_user_id", "title", "languages", "screen_language", "updated_at")
       VALUES ($1, $2, 'Game night', 'both', 'en', now())`,
      [quizId, ownerUserId],
    );

  const failureOf = async (
    statement: Promise<unknown>,
  ): Promise<{ code?: string; constraint?: string }> => {
    try {
      await statement;
    } catch (error) {
      return error as { code?: string; constraint?: string };
    }
    throw new Error('Expected the statement to fail');
  };

  beforeAll(async () => {
    refuseUnlessTestDatabase(DATABASE_URL!);
    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      entities: [],
      dropSchema: true,
      synchronize: false,
    });
    await dataSource.initialize();
    // The tables and types as they stand before these migrations, cut down to
    // the columns and labels the migrations touch.
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await dataSource.query(`CREATE TABLE "users" ("id" uuid PRIMARY KEY)`);
    await dataSource.query(`CREATE TABLE "events" ("id" uuid PRIMARY KEY)`);
    await dataSource.query(
      `CREATE TYPE "reports_subject_type_enum" AS ENUM ('member')`,
    );
    await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1), ($2)`, [
      ORGANISER_USER,
      PLAYER_USER,
    ]);
    await dataSource.query(`INSERT INTO "events" ("id") VALUES ($1), ($2)`, [
      EVENT_ID,
      OTHER_EVENT_ID,
    ]);
    queryRunner = dataSource.createQueryRunner();
  }, 120000);

  afterAll(async () => {
    await queryRunner?.release();
    await dataSource?.destroy();
  });

  const quizshowTableNames = async (): Promise<string[]> => {
    const rows: { table_name: string }[] = await dataSource.query(
      `SELECT "table_name" FROM "information_schema"."tables"
        WHERE "table_schema" = 'public' AND "table_name" LIKE 'quizshow_%'
        ORDER BY "table_name"`,
    );
    return rows.map((row) => row.table_name);
  };

  it('runs both enum migrations outside the migration transaction and appends the labels', async () => {
    const answerEnumMigration = new AddQuizshowReportSubject1836000000000();
    const gameEnumMigration = new AddQuizshowGameReportSubject1837000000000();
    expect(answerEnumMigration.transaction).toBe(false);
    expect(gameEnumMigration.transaction).toBe(false);
    await answerEnumMigration.up(queryRunner);
    expect(await labelsOf('reports_subject_type_enum')).toEqual([
      'member',
      'quizshow_answer',
    ]);
    await gameEnumMigration.up(queryRunner);
    expect(await labelsOf('reports_subject_type_enum')).toEqual([
      'member',
      'quizshow_answer',
      'quizshow_game',
    ]);
    await expect(answerEnumMigration.down()).rejects.toThrow(/Irreversible/);
    await expect(gameEnumMigration.down()).rejects.toThrow(/Irreversible/);
  });

  it('creates nine tables, and the games migration adds the lobby opens table', async () => {
    await new AddQuizshow1836000100000().up(queryRunner);
    const eventOnlyTables = QUIZSHOW_TABLES.filter(
      (tableName) => tableName !== 'quizshow_lobby_opens',
    );
    expect(await quizshowTableNames()).toEqual([...eventOnlyTables].sort());

    await new AddQuizshowGames1837000100000().up(queryRunner);
    expect(await quizshowTableNames()).toEqual([...QUIZSHOW_TABLES].sort());
  });

  describe('with the tables in place', () => {
    afterEach(async () => {
      await dataSource.query(`DELETE FROM "quizshow_lobby_opens"`);
      await dataSource.query(`DELETE FROM "quizshow_quizzes"`);
      await dataSource.query(`DELETE FROM "quizshow_sessions"`);
      await dataSource.query(
        `INSERT INTO "users" ("id") VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
        [ORGANISER_USER, PLAYER_USER],
      );
      await dataSource.query(
        `INSERT INTO "events" ("id") VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
        [EVENT_ID, OTHER_EVENT_ID],
      );
    });

    it('refuses a second open session with the same join code and allows it once the first finished', async () => {
      await insertQuiz(QUIZ_ID, EVENT_ID);
      await insertQuiz(OTHER_QUIZ_ID, OTHER_EVENT_ID);
      const firstSessionId = 'd8300000-0000-4000-8000-000000000001';
      await insertSession(firstSessionId, EVENT_ID, QUIZ_ID, 'ABC234', 'lobby');
      await expect(
        insertSession(
          'd8300000-0000-4000-8000-000000000002',
          OTHER_EVENT_ID,
          OTHER_QUIZ_ID,
          'ABC234',
          'running',
        ),
      ).rejects.toThrow(/UQ_quizshow_sessions_open_join_code/);
      await dataSource.query(
        `UPDATE "quizshow_sessions" SET "status" = 'finished' WHERE "id" = $1`,
        [firstSessionId],
      );
      await insertSession(
        'd8300000-0000-4000-8000-000000000003',
        OTHER_EVENT_ID,
        OTHER_QUIZ_ID,
        'ABC234',
        'lobby',
      );
    });

    it('refuses a second open session for one event', async () => {
      await insertQuiz(QUIZ_ID, EVENT_ID);
      await insertSession(
        'd8300000-0000-4000-8000-000000000001',
        EVENT_ID,
        QUIZ_ID,
        'ABC234',
        'paused',
      );
      await expect(
        insertSession(
          'd8300000-0000-4000-8000-000000000002',
          EVENT_ID,
          QUIZ_ID,
          'XYZ789',
          'lobby',
        ),
      ).rejects.toThrow(/UQ_quizshow_sessions_open_event/);
    });

    it('refuses a quiz with both an event and an owner, and one with neither', async () => {
      const both = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("id", "event_id", "owner_user_id", "title", "languages", "screen_language", "updated_at")
           VALUES ($1, $2, $3, 'Both', 'both', 'en', now())`,
          [QUIZ_ID, EVENT_ID, ORGANISER_USER],
        ),
      );
      expect(both.code).toBe('23514');
      expect(both.constraint).toBe('CHK_quizshow_quizzes_scope');
      const neither = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("id", "title", "languages", "screen_language", "updated_at")
           VALUES ($1, 'Neither', 'both', 'en', now())`,
          [OTHER_QUIZ_ID],
        ),
      );
      expect(neither.code).toBe('23514');
      expect(neither.constraint).toBe('CHK_quizshow_quizzes_scope');
      expect(await countOf('quizshow_quizzes')).toBe(0);
    });

    it('keeps many games with no event under the event unique constraint', async () => {
      await insertGameQuiz(QUIZ_ID, ORGANISER_USER);
      await insertGameQuiz(OTHER_QUIZ_ID, ORGANISER_USER);
      expect(await countOf('quizshow_quizzes')).toBe(2);
      const rows: { is_adults_only: boolean }[] = await dataSource.query(
        `SELECT "is_adults_only" FROM "quizshow_quizzes"`,
      );
      expect(rows.every((row) => row.is_adults_only === false)).toBe(true);
    });

    it('refuses a second open session of one quiz and allows it once the first finished', async () => {
      await insertGameQuiz(QUIZ_ID, ORGANISER_USER);
      const firstSessionId = 'd8300000-0000-4000-8000-000000000001';
      await insertSession(firstSessionId, null, QUIZ_ID, 'ABC234', 'lobby');
      const refusal = await failureOf(
        insertSession(
          'd8300000-0000-4000-8000-000000000002',
          null,
          QUIZ_ID,
          'XYZ789',
          'running',
        ),
      );
      expect(refusal.code).toBe('23505');
      expect(refusal.constraint).toBe('UQ_quizshow_sessions_open_quiz');
      await dataSource.query(
        `UPDATE "quizshow_sessions" SET "status" = 'finished' WHERE "id" = $1`,
        [firstSessionId],
      );
      await insertSession(
        'd8300000-0000-4000-8000-000000000003',
        null,
        QUIZ_ID,
        'XYZ789',
        'lobby',
      );
    });

    it('deletes a game with its sessions, players and answers when the owner account is deleted', async () => {
      await insertGameQuiz(QUIZ_ID, ORGANISER_USER);
      const sessionId = 'd8300000-0000-4000-8000-000000000001';
      const playerId = 'd8400000-0000-4000-8000-000000000001';
      await insertSession(sessionId, null, QUIZ_ID, 'ABC234', 'running');
      await dataSource.query(
        `INSERT INTO "quizshow_players" ("id", "session_id", "user_id", "is_cohost_player", "screen_name", "joined_at")
         VALUES ($1, $2, $3, false, 'Sparkle', now())`,
        [playerId, sessionId, PLAYER_USER],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_answers" ("session_id", "question_id", "player_id", "payload", "received_at")
         VALUES ($1, $2, $3, '{}', now())`,
        [sessionId, 'd8700000-0000-4000-8000-000000000001', playerId],
      );

      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        ORGANISER_USER,
      ]);

      for (const tableName of [
        'quizshow_quizzes',
        'quizshow_sessions',
        'quizshow_players',
        'quizshow_answers',
      ]) {
        expect(await countOf(tableName)).toBe(0);
      }
    });

    it('keeps a game session with no event', async () => {
      await insertGameQuiz(QUIZ_ID, ORGANISER_USER);
      const sessionId = 'd8300000-0000-4000-8000-000000000001';
      await insertSession(sessionId, null, QUIZ_ID, 'ABC234', 'finished');
      const rows: { event_id: string | null }[] = await dataSource.query(
        `SELECT "event_id" FROM "quizshow_sessions" WHERE "id" = $1`,
        [sessionId],
      );
      expect(rows).toEqual([{ event_id: null }]);
    });

    it('creates the lobby opens table with its user and time index', async () => {
      const columns: {
        column_name: string;
        data_type: string;
        is_nullable: string;
        datetime_precision: number | null;
      }[] = await dataSource.query(
        `SELECT "column_name", "data_type", "is_nullable", "datetime_precision"
           FROM "information_schema"."columns"
          WHERE "table_name" = 'quizshow_lobby_opens'
          ORDER BY "column_name"`,
      );
      expect(columns).toEqual([
        {
          column_name: 'id',
          data_type: 'uuid',
          is_nullable: 'NO',
          datetime_precision: null,
        },
        {
          column_name: 'opened_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
          datetime_precision: 3,
        },
        {
          column_name: 'user_id',
          data_type: 'uuid',
          is_nullable: 'NO',
          datetime_precision: null,
        },
      ]);
      const indexes: { indexdef: string }[] = await dataSource.query(
        `SELECT "indexdef" FROM "pg_indexes"
          WHERE "tablename" = 'quizshow_lobby_opens'
            AND "indexname" = 'IDX_quizshow_lobby_opens_user_opened'`,
      );
      expect(indexes).toHaveLength(1);
      const [lobbyOpensIndex] = indexes;
      if (!lobbyOpensIndex) {
        throw new Error('Expected the lobby opens index');
      }
      expect(lobbyOpensIndex.indexdef).toContain('(user_id, opened_at)');
    });

    it('keeps lobby opens when the game is deleted and drops them with the account', async () => {
      await insertGameQuiz(QUIZ_ID, ORGANISER_USER);
      await insertSession(
        'd8300000-0000-4000-8000-000000000001',
        null,
        QUIZ_ID,
        'ABC234',
        'lobby',
      );
      await dataSource.query(
        `INSERT INTO "quizshow_lobby_opens" ("user_id") VALUES ($1), ($1)`,
        [ORGANISER_USER],
      );

      await dataSource.query(`DELETE FROM "quizshow_quizzes" WHERE "id" = $1`, [
        QUIZ_ID,
      ]);

      expect(await countOf('quizshow_sessions')).toBe(0);
      expect(await countOf('quizshow_lobby_opens')).toBe(2);
      const openedRows: { has_opened_at: boolean }[] = await dataSource.query(
        `SELECT "opened_at" IS NOT NULL AS "has_opened_at" FROM "quizshow_lobby_opens"`,
      );
      expect(openedRows.every((row) => row.has_opened_at)).toBe(true);

      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        ORGANISER_USER,
      ]);
      expect(await countOf('quizshow_lobby_opens')).toBe(0);
    });

    it('creates the owner, opener and quiz indexes', async () => {
      const rows: { indexname: string }[] = await dataSource.query(
        `SELECT "indexname" FROM "pg_indexes"
          WHERE "tablename" IN ('quizshow_quizzes', 'quizshow_sessions')
            AND "indexname" IN ('IDX_quizshow_quizzes_owner_user_id', 'IDX_quizshow_sessions_started_by_started_at', 'IDX_quizshow_sessions_quiz_id')
          ORDER BY "indexname"`,
      );
      expect(rows.map((row) => row.indexname)).toEqual([
        'IDX_quizshow_quizzes_owner_user_id',
        'IDX_quizshow_sessions_quiz_id',
        'IDX_quizshow_sessions_started_by_started_at',
      ]);
    });

    it('refuses two teams of one session whose names differ only by case', async () => {
      await insertQuiz(QUIZ_ID, EVENT_ID);
      const sessionId = 'd8300000-0000-4000-8000-000000000001';
      await insertSession(sessionId, EVENT_ID, QUIZ_ID, 'ABC234', 'lobby');
      await insertTeam(sessionId, 'Glitter Gang', 'circle');
      await expect(
        insertTeam(sessionId, 'glitter gang', 'star'),
      ).rejects.toThrow(/UQ_quizshow_teams_session_name/);
    });

    it('deletes every quizshow row when the event is deleted', async () => {
      await insertQuiz(QUIZ_ID, EVENT_ID);
      const sessionId = 'd8300000-0000-4000-8000-000000000001';
      const playerId = 'd8400000-0000-4000-8000-000000000001';
      const answerId = 'd8500000-0000-4000-8000-000000000001';
      const roundId = 'd8600000-0000-4000-8000-000000000001';
      await dataSource.query(
        `INSERT INTO "quizshow_rounds" ("id", "quiz_id", "position", "kind", "title_en", "title_pt", "content_label", "settings")
         VALUES ($1, $2, 1, 'quiz', 'Round', 'Ronda', 'none', '{}')`,
        [roundId, QUIZ_ID],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_questions" ("round_id", "position", "type", "prompt_en", "prompt_pt")
         VALUES ($1, 1, 'true_false', 'Is it?', 'E?')`,
        [roundId],
      );
      await insertSession(sessionId, EVENT_ID, QUIZ_ID, 'ABC234', 'finished');
      await insertTeam(sessionId, 'Glitter Gang', 'circle');
      await dataSource.query(
        `INSERT INTO "quizshow_players" ("id", "session_id", "user_id", "is_cohost_player", "screen_name", "joined_at")
         VALUES ($1, $2, $3, false, 'Sparkle', now())`,
        [playerId, sessionId, PLAYER_USER],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_answers" ("id", "session_id", "question_id", "player_id", "payload", "received_at")
         VALUES ($1, $2, $3, $4, '{}', now())`,
        [answerId, sessionId, 'd8700000-0000-4000-8000-000000000001', playerId],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_votes" ("session_id", "question_id", "voter_player_id", "answer_id")
         VALUES ($1, $2, $3, $4)`,
        [sessionId, 'd8700000-0000-4000-8000-000000000001', playerId, answerId],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_results" ("session_id", "podium", "placings", "question_stats")
         VALUES ($1, '[]', '{}', '{}')`,
        [sessionId],
      );
      // Lobby opens outlive games by design, so the event delete leaves them alone.
      const eventScopedTables = QUIZSHOW_TABLES.filter(
        (tableName) => tableName !== 'quizshow_lobby_opens',
      );
      for (const tableName of eventScopedTables) {
        expect(await countOf(tableName)).toBeGreaterThan(0);
      }

      await dataSource.query(`DELETE FROM "events" WHERE "id" = $1`, [
        EVENT_ID,
      ]);

      for (const tableName of eventScopedTables) {
        expect(await countOf(tableName)).toBe(0);
      }
    });

    it("keeps a player's row and nulls the hider when the hiding organiser's account is deleted", async () => {
      await insertQuiz(QUIZ_ID, EVENT_ID);
      const sessionId = 'd8300000-0000-4000-8000-000000000001';
      const playerId = 'd8400000-0000-4000-8000-000000000001';
      await insertSession(sessionId, EVENT_ID, QUIZ_ID, 'ABC234', 'running');
      await dataSource.query(
        `INSERT INTO "quizshow_players" ("id", "session_id", "user_id", "is_cohost_player", "screen_name", "joined_at")
         VALUES ($1, $2, $3, false, 'Sparkle', now())`,
        [playerId, sessionId, PLAYER_USER],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_answers" ("session_id", "question_id", "player_id", "payload", "received_at", "hidden_at", "hidden_by_user_id")
         VALUES ($1, $2, $3, '{}', now(), now(), $4)`,
        [
          sessionId,
          'd8700000-0000-4000-8000-000000000001',
          playerId,
          ORGANISER_USER,
        ],
      );

      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        ORGANISER_USER,
      ]);

      const answers: {
        player_id: string;
        hidden_by_user_id: string | null;
      }[] = await dataSource.query(
        `SELECT "player_id", "hidden_by_user_id" FROM "quizshow_answers"`,
      );
      expect(answers).toEqual([
        { player_id: playerId, hidden_by_user_id: null },
      ]);
      expect(await countOf('quizshow_players')).toBe(1);
    });
  });

  it('appends wheel to the round kind enum outside the migration transaction', async () => {
    const wheelMigration = new AddQuizshowWheel1840000000000();
    expect(wheelMigration.transaction).toBe(false);
    expect(await labelsOf('quizshow_round_kind')).toEqual([
      'quiz',
      'lie_detector',
      'caption_this',
      'drag_name',
    ]);
    await wheelMigration.up(queryRunner);
    expect(await labelsOf('quizshow_round_kind')).toEqual([
      'quiz',
      'lie_detector',
      'caption_this',
      'drag_name',
      'wheel',
    ]);
    await expect(wheelMigration.down()).rejects.toThrow(/Irreversible/);
  });

  describe('the templates migration', () => {
    const templatesMigration = new AddQuizshowTemplates1837900000000();
    const SEED_TEMPLATE_IDS = QUIZSHOW_TEMPLATE_SEEDS_1837900000000.map(
      (seed) => seed.id,
    );
    const STAFF_USER = 'd8000000-0000-4000-8000-000000000003';
    const STAFF_TEMPLATE_ID = 'd8800000-0000-4000-8000-000000000001';
    const STAFF_QUIZ_ID = 'd8200000-0000-4000-8000-000000000003';
    const HOST_QUIZ_ID = 'd8200000-0000-4000-8000-000000000004';

    const seedTemplateIdOf = (packKey: string): string => {
      const seed = QUIZSHOW_TEMPLATE_SEEDS_1837900000000.find(
        (candidate) => candidate.packKey === packKey,
      );
      if (!seed) {
        throw new Error(`Expected a seed for ${packKey}`);
      }
      return seed.id;
    };

    const insertStaffTemplate = async (
      templateId: string,
      quizId: string,
    ): Promise<void> => {
      await dataSource.query(
        `INSERT INTO "quizshow_templates" ("id", "card_title_en", "card_title_pt", "card_description_en", "card_description_pt")
         VALUES ($1, 'Staff quiz', 'Quiz da equipa', '', '')`,
        [templateId],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_quizzes" ("id", "template_id", "title", "languages", "screen_language", "updated_at")
         VALUES ($1, $2, 'Staff quiz', 'both', 'en', now())`,
        [quizId, templateId],
      );
    };

    const countOfTemplateQuizzes = async (): Promise<number> => {
      const rows: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "quizshow_quizzes" WHERE "template_id" IS NOT NULL`,
      );
      return rows[0]?.count ?? 0;
    };

    const columnNamesOf = async (tableName: string): Promise<string[]> => {
      const rows: { column_name: string }[] = await dataSource.query(
        `SELECT "column_name" FROM "information_schema"."columns"
          WHERE "table_name" = $1
          ORDER BY "column_name"`,
        [tableName],
      );
      return rows.map((row) => row.column_name);
    };

    beforeAll(async () => {
      await dataSource.query(
        `INSERT INTO "quizshow_quizzes" ("id", "event_id", "title", "languages", "screen_language", "starter_pack_key", "updated_at")
         VALUES ($1, $2, 'Eurovision night', 'both', 'en', 'eurovision', now())`,
        [QUIZ_ID, EVENT_ID],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_quizzes" ("id", "owner_user_id", "title", "languages", "screen_language", "starter_pack_key", "updated_at")
         VALUES ($1, $2, 'Game night', 'both', 'en', 'retired_pack', now())`,
        [OTHER_QUIZ_ID, PLAYER_USER],
      );
      await templatesMigration.up(queryRunner);
    });

    afterAll(async () => {
      await dataSource.query(`DELETE FROM "quizshow_quizzes"`);
      await dataSource.query(
        `INSERT INTO "users" ("id") VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
        [ORGANISER_USER, PLAYER_USER],
      );
      await dataSource.query(
        `INSERT INTO "events" ("id") VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
        [EVENT_ID, OTHER_EVENT_ID],
      );
    });

    it('seeds the five packs as drafts with every round, question and note', async () => {
      const templates: { id: string; is_draft: boolean }[] =
        await dataSource.query(
          `SELECT "id", "published_at" IS NULL AS "is_draft" FROM "quizshow_templates" ORDER BY "id"`,
        );
      expect(templates).toEqual(
        [...SEED_TEMPLATE_IDS]
          .sort()
          .map((templateId) => ({ id: templateId, is_draft: true })),
      );

      const quizzes: { template_id: string }[] = await dataSource.query(
        `SELECT "template_id" FROM "quizshow_quizzes" WHERE "template_id" IS NOT NULL ORDER BY "template_id"`,
      );
      expect(quizzes.map((quiz) => quiz.template_id)).toEqual(
        [...SEED_TEMPLATE_IDS].sort(),
      );

      const contentCounts: { round_count: number; question_count: number }[] =
        await dataSource.query(
          `SELECT
             (SELECT COUNT(*)::int FROM "quizshow_rounds" AS "round"
                JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
               WHERE "quiz"."template_id" IS NOT NULL) AS "round_count",
             (SELECT COUNT(*)::int FROM "quizshow_questions" AS "question"
                JOIN "quizshow_rounds" AS "round" ON "round"."id" = "question"."round_id"
                JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
               WHERE "quiz"."template_id" IS NOT NULL) AS "question_count"`,
        );
      expect(contentCounts).toEqual([{ round_count: 16, question_count: 83 }]);

      const noteLines: { count: number }[] = await dataSource.query(
        `SELECT SUM(cardinality(string_to_array("staff_notes", chr(10))))::int AS "count" FROM "quizshow_templates"`,
      );
      expect(noteLines).toEqual([{ count: 83 }]);

      const lisbonQuizzes: { screen_language: string }[] =
        await dataSource.query(
          `SELECT "screen_language" FROM "quizshow_quizzes" WHERE "template_id" = $1`,
          [seedTemplateIdOf('lisbon_queer_icons')],
        );
      expect(lisbonQuizzes).toEqual([{ screen_language: 'pt' }]);

      const firstPrideQuestions: { is_match: boolean }[] =
        await dataSource.query(
          `SELECT "question"."answer" = '{"correctIndex": 1}'::jsonb AS "is_match"
             FROM "quizshow_questions" AS "question"
             JOIN "quizshow_rounds" AS "round" ON "round"."id" = "question"."round_id"
             JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
            WHERE "quiz"."template_id" = $1 AND "round"."position" = 0 AND "question"."position" = 0`,
          [seedTemplateIdOf('pride_history')],
        );
      expect(firstPrideQuestions).toEqual([{ is_match: true }]);
    });

    it('rebuilds every seeded template from the database exactly as the frozen seed holds it', async () => {
      const templateRows: {
        id: string;
        card_title_en: string;
        card_title_pt: string;
        card_description_en: string;
        card_description_pt: string;
        staff_notes: string;
      }[] = await dataSource.query(
        `SELECT "id", "card_title_en", "card_title_pt", "card_description_en", "card_description_pt", "staff_notes"
           FROM "quizshow_templates"
          WHERE "id" = ANY($1::uuid[])`,
        [SEED_TEMPLATE_IDS],
      );
      const quizRows: {
        id: string;
        template_id: string;
        title: string;
        languages: string;
        screen_language: string;
      }[] = await dataSource.query(
        `SELECT "id", "template_id", "title", "languages", "screen_language"
           FROM "quizshow_quizzes"
          WHERE "template_id" = ANY($1::uuid[])`,
        [SEED_TEMPLATE_IDS],
      );
      const roundRows: {
        id: string;
        quiz_id: string;
        position: number;
        kind: string;
        title_en: string;
        title_pt: string;
        content_label: string;
        settings: Record<string, number | boolean>;
      }[] = await dataSource.query(
        `SELECT "round"."id", "round"."quiz_id", "round"."position", "round"."kind",
                "round"."title_en", "round"."title_pt", "round"."content_label", "round"."settings"
           FROM "quizshow_rounds" AS "round"
           JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
          WHERE "quiz"."template_id" = ANY($1::uuid[])
          ORDER BY "round"."quiz_id", "round"."position"`,
        [SEED_TEMPLATE_IDS],
      );
      const questionRows: {
        round_id: string;
        position: number;
        type: string;
        prompt_en: string;
        prompt_pt: string;
        media_ref: string | null;
        options: unknown[];
        answer: Record<string, unknown> | null;
        accepted_answers: string[];
        time_limit_seconds: number | null;
        points: number;
      }[] = await dataSource.query(
        `SELECT "question"."round_id", "question"."position", "question"."type",
                "question"."prompt_en", "question"."prompt_pt", "question"."media_ref",
                "question"."options", "question"."answer", "question"."accepted_answers",
                "question"."time_limit_seconds", "question"."points"
           FROM "quizshow_questions" AS "question"
           JOIN "quizshow_rounds" AS "round" ON "round"."id" = "question"."round_id"
           JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
          WHERE "quiz"."template_id" = ANY($1::uuid[])
          ORDER BY "question"."round_id", "question"."position"`,
        [SEED_TEMPLATE_IDS],
      );

      const questionsOfRound = (roundId: string) => {
        const rowsOfRound = questionRows.filter(
          (questionRow) => questionRow.round_id === roundId,
        );
        expect(rowsOfRound.map((questionRow) => questionRow.position)).toEqual([
          ...rowsOfRound.keys(),
        ]);
        return rowsOfRound.map((questionRow) => ({
          type: questionRow.type,
          prompt: { en: questionRow.prompt_en, pt: questionRow.prompt_pt },
          options: questionRow.options,
          answer: questionRow.answer,
          acceptedAnswers: questionRow.accepted_answers,
          mediaRef: questionRow.media_ref,
          timeLimitSeconds: questionRow.time_limit_seconds,
          points: questionRow.points,
        }));
      };

      const roundsOfQuiz = (quizId: string) => {
        const rowsOfQuiz = roundRows.filter(
          (roundRow) => roundRow.quiz_id === quizId,
        );
        expect(rowsOfQuiz.map((roundRow) => roundRow.position)).toEqual([
          ...rowsOfQuiz.keys(),
        ]);
        return rowsOfQuiz.map((roundRow) => ({
          kind: roundRow.kind,
          title: { en: roundRow.title_en, pt: roundRow.title_pt },
          contentLabel: roundRow.content_label,
          settings: roundRow.settings,
          questions: questionsOfRound(roundRow.id),
        }));
      };

      const rebuiltTemplateOf = (templateId: string) => {
        const templateRow = templateRows.find(
          (candidate) => candidate.id === templateId,
        );
        const quizRowsOfTemplate = quizRows.filter(
          (quizRow) => quizRow.template_id === templateId,
        );
        expect(quizRowsOfTemplate).toHaveLength(1);
        const quizRow = quizRowsOfTemplate[0];
        if (!templateRow || !quizRow) {
          throw new Error(`Expected template ${templateId} with its quiz`);
        }
        return {
          id: templateRow.id,
          cardTitle: {
            en: templateRow.card_title_en,
            pt: templateRow.card_title_pt,
          },
          cardDescription: {
            en: templateRow.card_description_en,
            pt: templateRow.card_description_pt,
          },
          staffNotes: templateRow.staff_notes,
          quiz: {
            title: quizRow.title,
            languages: quizRow.languages,
            screenLanguage: quizRow.screen_language,
            rounds: roundsOfQuiz(quizRow.id),
          },
        };
      };

      expect(templateRows).toHaveLength(
        QUIZSHOW_TEMPLATE_SEEDS_1837900000000.length,
      );
      expect(
        QUIZSHOW_TEMPLATE_SEEDS_1837900000000.map((seed) =>
          rebuiltTemplateOf(seed.id),
        ),
      ).toStrictEqual(
        QUIZSHOW_TEMPLATE_SEEDS_1837900000000.map((seed) => ({
          id: seed.id,
          cardTitle: seed.cardTitle,
          cardDescription: seed.cardDescription,
          staffNotes: seed.staffNotes,
          quiz: seed.quiz,
        })),
      );

      const answerNullCounts: {
        sql_null_count: number;
        json_null_count: number;
      }[] = await dataSource.query(
        `SELECT COUNT(*) FILTER (WHERE "question"."answer" IS NULL)::int AS "sql_null_count",
                COUNT(*) FILTER (WHERE jsonb_typeof("question"."answer") = 'null')::int AS "json_null_count"
           FROM "quizshow_questions" AS "question"
           JOIN "quizshow_rounds" AS "round" ON "round"."id" = "question"."round_id"
           JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
          WHERE "quiz"."template_id" = ANY($1::uuid[])`,
        [SEED_TEMPLATE_IDS],
      );
      expect(answerNullCounts).toEqual([
        { sql_null_count: 3, json_null_count: 0 },
      ]);
    });

    it('backfills the source template from the retired pack key and drops the key', async () => {
      const sources: { id: string; source_template_id: string | null }[] =
        await dataSource.query(
          `SELECT "id", "source_template_id" FROM "quizshow_quizzes" WHERE "id" IN ($1, $2) ORDER BY "id"`,
          [QUIZ_ID, OTHER_QUIZ_ID],
        );
      expect(sources).toEqual([
        { id: QUIZ_ID, source_template_id: seedTemplateIdOf('eurovision') },
        { id: OTHER_QUIZ_ID, source_template_id: null },
      ]);
      expect(await columnNamesOf('quizshow_quizzes')).not.toContain(
        'starter_pack_key',
      );
    });

    it('refuses a quiz with a template and an event, and a quiz with no scope', async () => {
      const templateAndEvent = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("event_id", "template_id", "title", "languages", "screen_language", "updated_at")
           VALUES ($1, $2, 'Both', 'both', 'en', now())`,
          [OTHER_EVENT_ID, seedTemplateIdOf('pride_history')],
        ),
      );
      expect(templateAndEvent.code).toBe('23514');
      expect(templateAndEvent.constraint).toBe('CHK_quizshow_quizzes_scope');
      const noScope = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("title", "languages", "screen_language", "updated_at")
           VALUES ('Neither', 'both', 'en', now())`,
        ),
      );
      expect(noScope.code).toBe('23514');
      expect(noScope.constraint).toBe('CHK_quizshow_quizzes_scope');
    });

    it('refuses a second quiz for one template', async () => {
      const refusal = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("template_id", "title", "languages", "screen_language", "updated_at")
           VALUES ($1, 'Second', 'both', 'en', now())`,
          [seedTemplateIdOf('pride_history')],
        ),
      );
      expect(refusal.code).toBe('23505');
      expect(refusal.constraint).toBe('UQ_quizshow_quizzes_template_id');
    });

    it('keeps templates and nulls their authors when the staff account is deleted', async () => {
      const prideTemplateId = seedTemplateIdOf('pride_history');
      await dataSource.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
        STAFF_USER,
      ]);
      await dataSource.query(
        `UPDATE "quizshow_quizzes" SET "created_by_user_id" = $1, "updated_by_user_id" = $1 WHERE "template_id" = $2`,
        [STAFF_USER, prideTemplateId],
      );
      await dataSource.query(
        `UPDATE "quizshow_templates" SET "published_by_user_id" = $1 WHERE "id" = $2`,
        [STAFF_USER, prideTemplateId],
      );

      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        STAFF_USER,
      ]);

      const templates: { published_by_user_id: string | null }[] =
        await dataSource.query(
          `SELECT "published_by_user_id" FROM "quizshow_templates" WHERE "id" = $1`,
          [prideTemplateId],
        );
      expect(templates).toEqual([{ published_by_user_id: null }]);
      const quizzes: {
        created_by_user_id: string | null;
        updated_by_user_id: string | null;
      }[] = await dataSource.query(
        `SELECT "created_by_user_id", "updated_by_user_id" FROM "quizshow_quizzes" WHERE "template_id" = $1`,
        [prideTemplateId],
      );
      expect(quizzes).toEqual([
        { created_by_user_id: null, updated_by_user_id: null },
      ]);
    });

    it('keeps templates when an event or a game owner goes', async () => {
      await dataSource.query(`DELETE FROM "events" WHERE "id" = $1`, [
        EVENT_ID,
      ]);
      await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
        PLAYER_USER,
      ]);

      expect(await countOf('quizshow_templates')).toBe(5);
      expect(await countOfTemplateQuizzes()).toBe(5);
    });

    it('deletes a template with its quiz, rounds and questions and keeps the host copy with no source', async () => {
      await insertStaffTemplate(STAFF_TEMPLATE_ID, STAFF_QUIZ_ID);
      const roundId = 'd8600000-0000-4000-8000-000000000001';
      await dataSource.query(
        `INSERT INTO "quizshow_rounds" ("id", "quiz_id", "position", "kind", "title_en", "title_pt", "content_label", "settings")
         VALUES ($1, $2, 0, 'quiz', 'Round', 'Ronda', 'none', '{}')`,
        [roundId, STAFF_QUIZ_ID],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_questions" ("round_id", "position", "type", "prompt_en", "prompt_pt")
         VALUES ($1, 0, 'true_false', 'Is it?', 'E?')`,
        [roundId],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_quizzes" ("id", "event_id", "source_template_id", "title", "languages", "screen_language", "updated_at")
         VALUES ($1, $2, $3, 'Host copy', 'both', 'en', now())`,
        [HOST_QUIZ_ID, OTHER_EVENT_ID, STAFF_TEMPLATE_ID],
      );

      await dataSource.query(
        `DELETE FROM "quizshow_templates" WHERE "id" = $1`,
        [STAFF_TEMPLATE_ID],
      );

      const staffQuizzes: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "quizshow_quizzes" WHERE "id" = $1`,
        [STAFF_QUIZ_ID],
      );
      expect(staffQuizzes).toEqual([{ count: 0 }]);
      const staffRounds: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "quizshow_rounds" WHERE "id" = $1`,
        [roundId],
      );
      expect(staffRounds).toEqual([{ count: 0 }]);
      const staffQuestions: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "quizshow_questions" WHERE "round_id" = $1`,
        [roundId],
      );
      expect(staffQuestions).toEqual([{ count: 0 }]);
      const hostQuizzes: { source_template_id: string | null }[] =
        await dataSource.query(
          `SELECT "source_template_id" FROM "quizshow_quizzes" WHERE "id" = $1`,
          [HOST_QUIZ_ID],
        );
      expect(hostQuizzes).toEqual([{ source_template_id: null }]);
    });

    // Runs up and down inside this block, before the templates migration's own
    // down, so the counts above and below only ever see the five original seeds.
    describe('the wheel templates migration', () => {
      const wheelTemplatesMigration =
        new AddQuizshowWheelTemplates1840100000000();
      const WHEEL_TEMPLATE_IDS =
        QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000.map((seed) => seed.id);
      const SETTINGS_KEYS = [
        'isJokerAllowed',
        'isSpeedBonusOn',
        'sliceCount',
        'timeLimitSeconds',
        'voteSeconds',
        'wheelBonus',
        'wheelPick',
        'writeSeconds',
      ];

      beforeAll(async () => {
        await wheelTemplatesMigration.up(queryRunner);
      });

      it('seeds the five wheel packs as drafts with a wheel row first', async () => {
        const templates: { id: string; is_draft: boolean }[] =
          await dataSource.query(
            `SELECT "id", "published_at" IS NULL AS "is_draft" FROM "quizshow_templates" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
            [WHEEL_TEMPLATE_IDS],
          );
        expect(templates).toEqual(
          [...WHEEL_TEMPLATE_IDS]
            .sort()
            .map((templateId) => ({ id: templateId, is_draft: true })),
        );

        const contentCounts: {
          round_count: number;
          question_count: number;
        }[] = await dataSource.query(
          `SELECT
             (SELECT COUNT(*)::int FROM "quizshow_rounds" AS "round"
                JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
               WHERE "quiz"."template_id" = ANY($1::uuid[])) AS "round_count",
             (SELECT COUNT(*)::int FROM "quizshow_questions" AS "question"
                JOIN "quizshow_rounds" AS "round" ON "round"."id" = "question"."round_id"
                JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
               WHERE "quiz"."template_id" = ANY($1::uuid[])) AS "question_count"`,
          [WHEEL_TEMPLATE_IDS],
        );
        expect(contentCounts).toEqual([
          { round_count: 35, question_count: 149 },
        ]);

        const firstRounds: {
          template_id: string;
          kind: string;
          wheel_pick: string;
        }[] = await dataSource.query(
          `SELECT "quiz"."template_id", "round"."kind", "round"."settings"->>'wheelPick' AS "wheel_pick"
             FROM "quizshow_rounds" AS "round"
             JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
            WHERE "quiz"."template_id" = ANY($1::uuid[]) AND "round"."position" = 0
            ORDER BY "quiz"."template_id"`,
          [WHEEL_TEMPLATE_IDS],
        );
        expect(firstRounds).toEqual(
          QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000.map((seed) => ({
            template_id: seed.id,
            kind: 'wheel',
            wheel_pick: seed.quiz.rounds[0]?.settings.wheelPick,
          })).sort((first, second) =>
            first.template_id.localeCompare(second.template_id),
          ),
        );

        const roundSettingsKeys: { keys: string[] }[] = await dataSource.query(
          `SELECT ARRAY(SELECT jsonb_object_keys("round"."settings")) AS "keys"
             FROM "quizshow_rounds" AS "round"
             JOIN "quizshow_quizzes" AS "quiz" ON "quiz"."id" = "round"."quiz_id"
            WHERE "quiz"."template_id" = ANY($1::uuid[])`,
          [WHEEL_TEMPLATE_IDS],
        );
        expect(roundSettingsKeys).toHaveLength(35);
        for (const row of roundSettingsKeys) {
          expect([...row.keys].sort()).toEqual(SETTINGS_KEYS);
        }
      });

      it('removes exactly the five wheel templates on down', async () => {
        const templateCountBefore = await countOf('quizshow_templates');
        await wheelTemplatesMigration.down(queryRunner);
        expect(await countOf('quizshow_templates')).toBe(
          templateCountBefore - 5,
        );

        const remainingWheelRows: { count: number }[] = await dataSource.query(
          `SELECT
             (SELECT COUNT(*)::int FROM "quizshow_templates" WHERE "id" = ANY($1::uuid[]))
           + (SELECT COUNT(*)::int FROM "quizshow_quizzes" WHERE "template_id" = ANY($1::uuid[])) AS "count"`,
          [WHEEL_TEMPLATE_IDS],
        );
        expect(remainingWheelRows).toEqual([{ count: 0 }]);
        const originalTemplates: { count: number }[] = await dataSource.query(
          `SELECT COUNT(*)::int AS "count" FROM "quizshow_templates" WHERE "id" = ANY($1::uuid[])`,
          [SEED_TEMPLATE_IDS],
        );
        expect(originalTemplates).toEqual([{ count: 5 }]);
      });
    });

    // Runs after the wheel templates block and before the templates
    // migration's own down, which drops the template table this one alters.
    // Its rows go in afterAll, so the template counts below stay as they were.
    describe('the live v2 migration', () => {
      const liveV2Migration = new QuizshowLiveV21840900000000();
      const LIVE_V2_USER = 'd8000000-0000-4000-8000-000000000004';
      const LIVE_V2_TEMPLATE_ID = 'd8800000-0000-4000-8000-000000000002';
      const LIVE_V2_QUIZ_ID = 'd8200000-0000-4000-8000-000000000005';
      const LIVE_V2_ROUND_ID = 'd8600000-0000-4000-8000-000000000002';
      const MULTIPLE_CHOICE_QUESTION_ID =
        'd8700000-0000-4000-8000-000000000002';
      const CLOSEST_QUESTION_ID = 'd8700000-0000-4000-8000-000000000003';
      const LATE_COPY_QUIZ_ID = 'd8200000-0000-4000-8000-000000000006';
      const DRAFT_COPY_QUIZ_ID = 'd8200000-0000-4000-8000-000000000007';
      /** One closest row per year rule case, keyed by question id. */
      const CLOSEST_CASES: ReadonlyArray<{
        questionId: string;
        storedAnswer: string;
        expectedAnswer: unknown;
      }> = [
        {
          questionId: 'd8700000-0000-4000-8000-000000000004',
          storedAnswer: '{"value":1995}',
          expectedAnswer: {
            value: 1995,
            tolerance: { mode: 'absolute', amount: 5 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-000000000005',
          storedAnswer: '{"value":2100}',
          expectedAnswer: {
            value: 2100,
            tolerance: { mode: 'absolute', amount: 5 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-000000000006',
          storedAnswer: '{"value":1000}',
          expectedAnswer: {
            value: 1000,
            tolerance: { mode: 'absolute', amount: 10 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-000000000007',
          storedAnswer: '{"value":2101}',
          expectedAnswer: {
            value: 2101,
            tolerance: { mode: 'percent', amount: 10 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-000000000008',
          storedAnswer: '{"value":1984.5}',
          expectedAnswer: {
            value: 1984.5,
            tolerance: { mode: 'percent', amount: 10 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-000000000009',
          storedAnswer: '{"value":42}',
          expectedAnswer: {
            value: 42,
            tolerance: { mode: 'percent', amount: 10 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-00000000000a',
          storedAnswer: '{"value":"1984"}',
          expectedAnswer: {
            value: '1984',
            tolerance: { mode: 'percent', amount: 10 },
          },
        },
        {
          questionId: 'd8700000-0000-4000-8000-00000000000b',
          storedAnswer:
            '{"value":1984,"tolerance":{"mode":"absolute","amount":2}}',
          expectedAnswer: {
            value: 1984,
            tolerance: { mode: 'absolute', amount: 2 },
          },
        },
      ];

      /** The stored answer and units of one question of a seeded template. */
      const seededQuestionOf = async (
        templateId: string,
        roundPosition: number,
        questionPosition: number,
      ): Promise<{
        answer: unknown;
        number_unit_en: string;
        number_unit_pt: string;
      }> => {
        const rows: {
          answer: unknown;
          number_unit_en: string;
          number_unit_pt: string;
        }[] = await dataSource.query(
          `SELECT "question"."answer", "question"."number_unit_en", "question"."number_unit_pt"
             FROM "quizshow_questions" "question"
             JOIN "quizshow_rounds" "round" ON "round"."id" = "question"."round_id"
             JOIN "quizshow_quizzes" "quiz" ON "quiz"."id" = "round"."quiz_id"
            WHERE "quiz"."template_id" = $1 AND "round"."position" = $2 AND "question"."position" = $3`,
          [templateId, roundPosition, questionPosition],
        );
        if (rows[0] === undefined) {
          throw new Error(
            `Expected a seeded question at ${templateId} ${roundPosition}/${questionPosition}`,
          );
        }
        return rows[0];
      };

      const storedAnswerOf = async (questionId: string): Promise<unknown> => {
        const rows: { answer: unknown }[] = await dataSource.query(
          `SELECT "answer" FROM "quizshow_questions" WHERE "id" = $1`,
          [questionId],
        );
        return rows[0]?.answer;
      };

      const storedSettingsOf = async (roundId: string): Promise<unknown> => {
        const rows: { settings: unknown }[] = await dataSource.query(
          `SELECT "settings" FROM "quizshow_rounds" WHERE "id" = $1`,
          [roundId],
        );
        return rows[0]?.settings;
      };

      /** Every statement `up` sends, in order, without touching the database. */
      const recordedStatements = async (): Promise<RecordedStatement[]> =>
        recordedStatementsOf(liveV2Migration);

      beforeAll(async () => {
        await dataSource.query(
          `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
          [LIVE_V2_USER],
        );
        await dataSource.query(
          `INSERT INTO "quizshow_templates" ("id", "card_title_en", "card_title_pt", "card_description_en", "card_description_pt", "published_at")
           VALUES ($1, 'Published quiz', 'Quiz publicado', '', '', '2026-10-01T12:00:00.000Z')`,
          [LIVE_V2_TEMPLATE_ID],
        );
        await dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("id", "owner_user_id", "source_template_id", "title", "languages", "screen_language", "created_at", "updated_at")
           VALUES ($1, $2, $3, 'Copied game', 'both', 'en', '2026-10-05T09:30:00.000Z', now())`,
          [LIVE_V2_QUIZ_ID, LIVE_V2_USER, LIVE_V2_TEMPLATE_ID],
        );
        await dataSource.query(
          `INSERT INTO "quizshow_rounds" ("id", "quiz_id", "position", "kind", "title_en", "title_pt", "content_label", "settings")
           VALUES ($1, $2, 0, 'quiz', 'Round', 'Ronda', 'none', '{"timeLimitSeconds":20}')`,
          [LIVE_V2_ROUND_ID, LIVE_V2_QUIZ_ID],
        );
        await dataSource.query(
          `INSERT INTO "quizshow_questions" ("id", "round_id", "position", "type", "prompt_en", "prompt_pt", "answer")
           VALUES ($1, $3, 0, 'multiple_choice', 'Which one?', 'Qual?', '{"correctIndex":2}'),
                  ($2, $3, 1, 'closest_number', 'What year?', 'Que ano?', '{"value":1969}')`,
          [MULTIPLE_CHOICE_QUESTION_ID, CLOSEST_QUESTION_ID, LIVE_V2_ROUND_ID],
        );
        for (const [caseIndex, closestCase] of CLOSEST_CASES.entries()) {
          await dataSource.query(
            `INSERT INTO "quizshow_questions" ("id", "round_id", "position", "type", "prompt_en", "prompt_pt", "answer")
             VALUES ($1, $2, $3, 'closest_number', 'How many?', 'Quantos?', $4::jsonb)`,
            [
              closestCase.questionId,
              LIVE_V2_ROUND_ID,
              caseIndex + 2,
              closestCase.storedAnswer,
            ],
          );
        }
        // Created before the template was published: the copy time is the
        // publish time.
        await dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("id", "owner_user_id", "source_template_id", "title", "languages", "screen_language", "created_at", "updated_at")
           VALUES ($1, $2, $3, 'Imported later', 'both', 'en', '2026-09-20T09:30:00.000Z', now())`,
          [LATE_COPY_QUIZ_ID, LIVE_V2_USER, LIVE_V2_TEMPLATE_ID],
        );
        // A copy of a draft template: the publish time is null, so the copy
        // time is the creation time.
        await dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("id", "owner_user_id", "source_template_id", "title", "languages", "screen_language", "created_at", "updated_at")
           VALUES ($1, $2, $3, 'Draft copy', 'both', 'en', '2026-09-21T09:30:00.000Z', now())`,
          [
            DRAFT_COPY_QUIZ_ID,
            LIVE_V2_USER,
            QUIZSHOW_TEMPLATE_SEEDS_1837900000000[0]?.id,
          ],
        );
      });

      afterAll(async () => {
        await dataSource.query(
          `DELETE FROM "quizshow_quizzes" WHERE "id" = ANY($1::uuid[])`,
          [[LIVE_V2_QUIZ_ID, LATE_COPY_QUIZ_ID, DRAFT_COPY_QUIZ_ID]],
        );
        await dataSource.query(
          `DELETE FROM "quizshow_templates" WHERE "id" = $1`,
          [LIVE_V2_TEMPLATE_ID],
        );
        await dataSource.query(`DELETE FROM "users" WHERE "id" = $1`, [
          LIVE_V2_USER,
        ]);
      });

      it('runs outside the migration transaction and appends poll, the 16 team keys and both', async () => {
        expect(liveV2Migration.transaction).toBe(false);
        expect(await labelsOf('quizshow_question_type')).toEqual([
          'multiple_choice',
          'true_false',
          'type_answer',
          'order',
          'closest_number',
          'prompt',
        ]);
        const tierOneKeys = [
          'circle',
          'triangle',
          'square',
          'diamond',
          'star',
          'hexagon',
          'heart',
          'moon',
        ];
        expect(await labelsOf('quizshow_team_color_key')).toEqual(tierOneKeys);
        expect(await labelsOf('quizshow_language')).toEqual(['en', 'pt']);

        await liveV2Migration.up(queryRunner);

        expect(await labelsOf('quizshow_question_type')).toEqual([
          'multiple_choice',
          'true_false',
          'type_answer',
          'order',
          'closest_number',
          'prompt',
          'poll',
        ]);
        expect(await labelsOf('quizshow_team_color_key')).toEqual([
          ...tierOneKeys,
          ...tierOneKeys.map((shape) => `${shape}_2`),
          ...tierOneKeys.map((shape) => `${shape}_3`),
        ]);
        expect(await labelsOf('quizshow_language')).toEqual([
          'en',
          'pt',
          'both',
        ]);
        await expect(liveV2Migration.down()).rejects.toThrow(
          /Irreversible: QuizshowLiveV21840900000000/,
        );
      });

      it('rewrites stored answers, round settings and the copy and content times', async () => {
        expect(await storedAnswerOf(MULTIPLE_CHOICE_QUESTION_ID)).toEqual({
          correctIndexes: [2],
        });
        expect(await storedAnswerOf(CLOSEST_QUESTION_ID)).toEqual({
          value: 1969,
          tolerance: { mode: 'absolute', amount: 10 },
        });
        expect(await storedSettingsOf(LIVE_V2_ROUND_ID)).toEqual({
          timeLimitSeconds: 20,
          isWarmUp: false,
          talkSeconds: 0,
        });

        const quizzes: { is_copied_at_created_at: boolean }[] =
          await dataSource.query(
            `SELECT "source_template_copied_at" = "created_at" AS "is_copied_at_created_at"
               FROM "quizshow_quizzes" WHERE "id" = $1`,
            [LIVE_V2_QUIZ_ID],
          );
        expect(quizzes).toEqual([{ is_copied_at_created_at: true }]);
        const copyTimes: { id: string; source_template_copied_at: Date }[] =
          await dataSource.query(
            `SELECT "id", "source_template_copied_at" FROM "quizshow_quizzes"
              WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
            [[LATE_COPY_QUIZ_ID, DRAFT_COPY_QUIZ_ID]],
          );
        expect(
          copyTimes.map((row) => [
            row.id,
            new Date(row.source_template_copied_at).toISOString(),
          ]),
        ).toEqual([
          [LATE_COPY_QUIZ_ID, '2026-10-01T12:00:00.000Z'],
          [DRAFT_COPY_QUIZ_ID, '2026-09-21T09:30:00.000Z'],
        ]);
        const templates: { is_content_at_published_at: boolean }[] =
          await dataSource.query(
            `SELECT "content_updated_at" = "published_at" AS "is_content_at_published_at"
               FROM "quizshow_templates" WHERE "id" = $1`,
            [LIVE_V2_TEMPLATE_ID],
          );
        expect(templates).toEqual([{ is_content_at_published_at: true }]);

        const questions: {
          media_alt_en: string;
          reveal_note_pt: string;
          number_unit_en: string;
          media_reveal: string;
        }[] = await dataSource.query(
          `SELECT "media_alt_en", "reveal_note_pt", "number_unit_en", "media_reveal"
             FROM "quizshow_questions" WHERE "id" = $1`,
          [MULTIPLE_CHOICE_QUESTION_ID],
        );
        expect(questions).toEqual([
          {
            media_alt_en: '',
            reveal_note_pt: '',
            number_unit_en: '',
            media_reveal: 'instant',
          },
        ]);

        const newColumns: { table_name: string; column_name: string }[] =
          await dataSource.query(
            `SELECT "table_name", "column_name" FROM "information_schema"."columns"
              WHERE ("table_name", "column_name") IN (
                ('quizshow_questions', 'media_alt_en'), ('quizshow_questions', 'media_alt_pt'),
                ('quizshow_questions', 'reveal_note_en'), ('quizshow_questions', 'reveal_note_pt'),
                ('quizshow_questions', 'number_unit_en'), ('quizshow_questions', 'number_unit_pt'),
                ('quizshow_questions', 'media_reveal'),
                ('quizshow_sessions', 'is_practice'), ('quizshow_sessions', 'is_join_locked'),
                ('quizshow_sessions', 'is_auto_advance_on'), ('quizshow_sessions', 'paired_devices'),
                ('quizshow_sessions', 'answer_key_overrides'),
                ('quizshow_players', 'left_at'), ('quizshow_teams', 'is_host_made'),
                ('quizshow_quizzes', 'last_open_settings'), ('quizshow_quizzes', 'source_template_copied_at'),
                ('quizshow_templates', 'content_updated_at'), ('quizshow_templates', 'change_note_en'),
                ('quizshow_templates', 'change_note_pt'))`,
          );
        expect(newColumns).toHaveLength(19);
      });

      it('gives a whole year from 1000 to 2100 a band in years and every other closest answer 10%', async () => {
        for (const closestCase of CLOSEST_CASES) {
          expect(await storedAnswerOf(closestCase.questionId)).toEqual(
            closestCase.expectedAnswer,
          );
        }
      });

      it("gives the seeded template questions the demo's tolerance and unit", async () => {
        const prideHistoryId = 'a7e3b1c0-5eed-4000-8000-000000000001';
        expect(await seededQuestionOf(prideHistoryId, 1, 4)).toEqual({
          answer: { value: 8, tolerance: { mode: 'exact', amount: 0 } },
          number_unit_en: 'stripes',
          number_unit_pt: 'riscas',
        });
        expect(await seededQuestionOf(prideHistoryId, 1, 5)).toEqual({
          answer: { value: 1989, tolerance: { mode: 'absolute', amount: 10 } },
          number_unit_en: '',
          number_unit_pt: '',
        });
        const eurovisionId = 'a7e3b1c0-5eed-4000-8000-000000000003';
        expect(await seededQuestionOf(eurovisionId, 1, 5)).toEqual({
          answer: { value: 758, tolerance: { mode: 'percent', amount: 10 } },
          number_unit_en: 'points',
          number_unit_pt: 'pontos',
        });
        const portugueseCultureId = 'a7e3b1c0-5eed-4000-8000-000000000002';
        expect(await seededQuestionOf(portugueseCultureId, 1, 4)).toEqual({
          answer: { value: 2000, tolerance: { mode: 'absolute', amount: 5 } },
          number_unit_en: '',
          number_unit_pt: '',
        });
        const lisbonIconsId = 'a7e3b1c0-5eed-4000-8000-000000000005';
        expect(await seededQuestionOf(lisbonIconsId, 2, 5)).toEqual({
          answer: { value: 22, tolerance: { mode: 'percent', amount: 10 } },
          number_unit_en: 'metres',
          number_unit_pt: 'metros',
        });
      });

      it('changes nothing when steps 5 to 7 run a second time', async () => {
        const statements = await recordedStatements();
        // 1 + 16 + 1 enum labels, then steps 4 to 12 (step 6 sends three
        // updates, 11 and 12 add an update each).
        expect(statements).toHaveLength(31);
        const dataStatements = statements.slice(19, 24);
        expect(dataStatements[0]?.statement).toContain('correctIndexes');
        expect(dataStatements[1]?.statement).toContain("'absolute'");
        expect(dataStatements[2]?.statement).toContain('"tolerance"');
        expect(dataStatements[3]?.statement).toContain('"number_unit_en"');
        expect(dataStatements[4]?.statement).toContain('"isWarmUp"');

        const prideHistoryId = 'a7e3b1c0-5eed-4000-8000-000000000001';
        const answersBefore = [
          await storedAnswerOf(MULTIPLE_CHOICE_QUESTION_ID),
          await storedAnswerOf(CLOSEST_QUESTION_ID),
          ...(await Promise.all(
            CLOSEST_CASES.map((closestCase) =>
              storedAnswerOf(closestCase.questionId),
            ),
          )),
          await seededQuestionOf(prideHistoryId, 1, 4),
        ];
        const settingsBefore = await storedSettingsOf(LIVE_V2_ROUND_ID);
        for (const { statement, parameters } of dataStatements) {
          await dataSource.query(statement, parameters);
        }
        expect([
          await storedAnswerOf(MULTIPLE_CHOICE_QUESTION_ID),
          await storedAnswerOf(CLOSEST_QUESTION_ID),
          ...(await Promise.all(
            CLOSEST_CASES.map((closestCase) =>
              storedAnswerOf(closestCase.questionId),
            ),
          )),
          await seededQuestionOf(prideHistoryId, 1, 4),
        ]).toEqual(answersBefore);
        expect(await storedSettingsOf(LIVE_V2_ROUND_ID)).toEqual(
          settingsBefore,
        );
      });

      it('refuses a media reveal outside instant and slow', async () => {
        const refusal = await failureOf(
          dataSource.query(
            `UPDATE "quizshow_questions" SET "media_reveal" = 'fast' WHERE "id" = $1`,
            [MULTIPLE_CHOICE_QUESTION_ID],
          ),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('CHK_quizshow_questions_media_reveal');
        await dataSource.query(
          `UPDATE "quizshow_questions" SET "media_reveal" = 'slow' WHERE "id" = $1`,
          [MULTIPLE_CHOICE_QUESTION_ID],
        );
      });
    });

    it('refuses down while a staff-made template remains, then removes exactly the five seeds and restores the pack key', async () => {
      // The earlier event delete took the backfilled event quiz, so this test
      // brings back an event quiz copied from the eurovision seed.
      await dataSource.query(
        `INSERT INTO "events" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [EVENT_ID],
      );
      await dataSource.query(
        `INSERT INTO "quizshow_quizzes" ("id", "event_id", "source_template_id", "title", "languages", "screen_language", "updated_at")
         VALUES ($1, $2, $3, 'Eurovision night', 'both', 'en', now())`,
        [QUIZ_ID, EVENT_ID, seedTemplateIdOf('eurovision')],
      );
      await insertStaffTemplate(STAFF_TEMPLATE_ID, STAFF_QUIZ_ID);

      await queryRunner.startTransaction();
      let refusal: { code?: string } | undefined;
      try {
        await templatesMigration.down(queryRunner);
      } catch (error) {
        refusal = error as { code?: string };
      }
      await queryRunner.rollbackTransaction();
      expect(refusal?.code).toBe('23514');
      expect(await countOf('quizshow_templates')).toBe(6);

      await dataSource.query(
        `DELETE FROM "quizshow_templates" WHERE "id" = $1`,
        [STAFF_TEMPLATE_ID],
      );
      await templatesMigration.down(queryRunner);

      const templateTables: { count: number }[] = await dataSource.query(
        `SELECT COUNT(*)::int AS "count" FROM "information_schema"."tables" WHERE "table_name" = 'quizshow_templates'`,
      );
      expect(templateTables).toEqual([{ count: 0 }]);
      const quizColumns = await columnNamesOf('quizshow_quizzes');
      expect(quizColumns).toContain('starter_pack_key');
      expect(quizColumns).not.toContain('source_template_id');
      expect(quizColumns).not.toContain('template_id');
      const packKeys: { starter_pack_key: string | null }[] =
        await dataSource.query(
          `SELECT "starter_pack_key" FROM "quizshow_quizzes" WHERE "id" = $1`,
          [QUIZ_ID],
        );
      expect(packKeys).toEqual([{ starter_pack_key: 'eurovision' }]);

      const noScope = await failureOf(
        dataSource.query(
          `INSERT INTO "quizshow_quizzes" ("title", "languages", "screen_language", "updated_at")
           VALUES ('Neither', 'both', 'en', now())`,
        ),
      );
      expect(noScope.code).toBe('23514');
      expect(noScope.constraint).toBe('CHK_quizshow_quizzes_scope');
    });
  });

  it('drops everything they created on down, newest migration first', async () => {
    await new AddQuizshowGames1837000100000().down(queryRunner);
    const nullableEventColumns: { table_name: string }[] =
      await dataSource.query(
        `SELECT "table_name" FROM "information_schema"."columns"
          WHERE "table_name" IN ('quizshow_quizzes', 'quizshow_sessions')
            AND "column_name" = 'event_id' AND "is_nullable" = 'YES'`,
      );
    expect(nullableEventColumns).toEqual([]);
    await new AddQuizshow1836000100000().down(queryRunner);
    const tables: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "information_schema"."tables" WHERE "table_name" LIKE 'quizshow_%'`,
    );
    const enumTypes: { count: number }[] = await dataSource.query(
      `SELECT COUNT(*)::int AS "count" FROM "pg_type" WHERE "typname" LIKE 'quizshow_%'`,
    );
    expect(tables).toEqual([{ count: 0 }]);
    expect(enumTypes).toEqual([{ count: 0 }]);
  });
});
