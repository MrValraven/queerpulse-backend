// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` require every `src/migrations/*.ts` file.
import { DataSource, QueryRunner } from 'typeorm';
import { AddQuizshowReportSubject1836000000000 } from '../migrations/1836000000000-AddQuizshowReportSubject';
import { AddQuizshow1836000100000 } from '../migrations/1836000100000-AddQuizshow';
import { AddQuizshowGameReportSubject1837000000000 } from '../migrations/1837000000000-AddQuizshowGameReportSubject';
import { AddQuizshowGames1837000100000 } from '../migrations/1837000100000-AddQuizshowGames';
import { AddQuizshowTemplates1837900000000 } from '../migrations/1837900000000-AddQuizshowTemplates';
import { QUIZSHOW_TEMPLATE_SEEDS_1837900000000 } from '../migrations/data/quizshow-templates-1837900000000.seed';

/**
 * Pulse Live migrations on real Postgres, in ledger order: the two
 * `1836000*` migrations as they ran in production, then the two `1837000*`
 * forward migrations that add games without an event, then the
 * `1837900000000` templates migration with its five seeded drafts. Skipped unless
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
