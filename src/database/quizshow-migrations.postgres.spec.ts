// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { AddQuizshowReportSubject1836000000000 } from '../migrations/1836000000000-AddQuizshowReportSubject';
import { AddQuizshow1836000100000 } from '../migrations/1836000100000-AddQuizshow';

/**
 * Pulse Live migrations on real Postgres. Skipped unless
 * `QUIZSHOW_MIGRATIONS_DATABASE_URL` names a database whose name ends in
 * `_test` (it drops and rebuilds the schema). Run it with, for example:
 *
 *   QUIZSHOW_MIGRATIONS_DATABASE_URL=postgres://postgres@127.0.0.1:55450/quizshow_test \
 *     npx jest src/database/quizshow-migrations.postgres.spec.ts
 */
const DATABASE_URL = process.env.QUIZSHOW_MIGRATIONS_DATABASE_URL;
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
    eventId: string,
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

  it('runs the enum migration outside the migration transaction and appends the label', async () => {
    const enumMigration = new AddQuizshowReportSubject1836000000000();
    expect(enumMigration.transaction).toBe(false);
    await enumMigration.up(queryRunner);
    expect(await labelsOf('reports_subject_type_enum')).toEqual([
      'member',
      'quizshow_answer',
    ]);
    await expect(enumMigration.down()).rejects.toThrow(/Irreversible/);
  });

  it('creates the nine tables', async () => {
    await new AddQuizshow1836000100000().up(queryRunner);
    const rows: { table_name: string }[] = await dataSource.query(
      `SELECT "table_name" FROM "information_schema"."tables"
        WHERE "table_schema" = 'public' AND "table_name" LIKE 'quizshow_%'
        ORDER BY "table_name"`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(
      [...QUIZSHOW_TABLES].sort(),
    );
  });

  describe('with the tables in place', () => {
    afterEach(async () => {
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
      for (const tableName of QUIZSHOW_TABLES) {
        expect(await countOf(tableName)).toBeGreaterThan(0);
      }

      await dataSource.query(`DELETE FROM "events" WHERE "id" = $1`, [
        EVENT_ID,
      ]);

      for (const tableName of QUIZSHOW_TABLES) {
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

  it('drops everything it created on down', async () => {
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
