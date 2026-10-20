// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pulse Live (code id `quizshow`): eight enum types and nine tables. Covered
 * by `src/database/quizshow-migrations.postgres.spec.ts`; the columns match
 * the entities in `src/quizshow/entities`.
 *
 * Retention rules the foreign keys carry:
 * - the quiz, its rounds and questions live until the event goes (event
 *   delete cascades);
 * - sessions follow the quiz and the event;
 * - players and teams live while the results are kept (`results_kept`), and
 *   cascade with the session and, for players, with the member's account;
 * - answers and votes are purged 30 days after the session and cascade with
 *   the session and the player;
 * - an organiser's account going away sets `started_by_user_id`,
 *   `hidden_by_user_id`, `created_by_user_id` and `updated_by_user_id` to null.
 *
 * At most one open session (lobby, running, paused) exists per join code and
 * per event, enforced by the two partial unique indexes. Team names are unique
 * per session ignoring case. Every timestamp is `timestamptz(3)`. The tables
 * are new and empty, so every index builds inside the migration transaction.
 */
export class AddQuizshow1836000100000 implements MigrationInterface {
  name = 'AddQuizshow1836000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "quizshow_language_mode" AS ENUM ('en', 'pt', 'both')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_language" AS ENUM ('en', 'pt')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_round_kind" AS ENUM ('quiz', 'lie_detector', 'caption_this', 'drag_name')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_content_label" AS ENUM ('none', 'spicy', 'sensitive', 'adults')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_question_type" AS ENUM ('multiple_choice', 'true_false', 'type_answer', 'order', 'closest_number', 'prompt')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_session_status" AS ENUM ('lobby', 'running', 'paused', 'finished', 'abandoned')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_play_mode" AS ENUM ('solo', 'teams')`,
    );
    await queryRunner.query(
      `CREATE TYPE "quizshow_team_color_key" AS ENUM ('circle', 'triangle', 'square', 'diamond', 'star', 'hexagon', 'heart', 'moon')`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_quizzes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "title" character varying(120) NOT NULL,
        "languages" "quizshow_language_mode" NOT NULL,
        "screen_language" "quizshow_language" NOT NULL,
        "starter_pack_key" character varying(40),
        "created_by_user_id" uuid,
        "updated_by_user_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_quizshow_quizzes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_quizzes_event_id" UNIQUE ("event_id"),
        CONSTRAINT "FK_quizshow_quizzes_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_quizzes_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_quizzes_updated_by" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "quizshow_rounds" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "quiz_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "kind" "quizshow_round_kind" NOT NULL,
        "title_en" character varying(80) NOT NULL,
        "title_pt" character varying(80) NOT NULL,
        "content_label" "quizshow_content_label" NOT NULL,
        "settings" jsonb NOT NULL,
        CONSTRAINT "PK_quizshow_rounds" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_rounds_quiz_position" UNIQUE ("quiz_id", "position"),
        CONSTRAINT "FK_quizshow_rounds_quiz" FOREIGN KEY ("quiz_id") REFERENCES "quizshow_quizzes"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "quizshow_questions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "round_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "type" "quizshow_question_type" NOT NULL,
        "prompt_en" character varying(280) NOT NULL,
        "prompt_pt" character varying(280) NOT NULL,
        "media_ref" character varying(512),
        "options" jsonb NOT NULL DEFAULT '[]',
        "answer" jsonb,
        "accepted_answers" jsonb NOT NULL DEFAULT '[]',
        "time_limit_seconds" integer,
        "points" integer NOT NULL DEFAULT 1000,
        CONSTRAINT "PK_quizshow_questions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_questions_round_position" UNIQUE ("round_id", "position"),
        CONSTRAINT "FK_quizshow_questions_round" FOREIGN KEY ("round_id") REFERENCES "quizshow_rounds"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "quizshow_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "quiz_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "status" "quizshow_session_status" NOT NULL,
        "join_code" character(6) NOT NULL,
        "play_mode" "quizshow_play_mode" NOT NULL,
        "max_team_size" integer,
        "is_review_on" boolean NOT NULL DEFAULT true,
        "cursor" jsonb NOT NULL,
        "question_log" jsonb NOT NULL DEFAULT '[]',
        "quiz_snapshot" jsonb NOT NULL,
        "started_by_user_id" uuid,
        "started_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "ended_at" TIMESTAMP(3) WITH TIME ZONE,
        "last_host_command_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "paused_at" TIMESTAMP(3) WITH TIME ZONE,
        "guest_push_sent_at" TIMESTAMP(3) WITH TIME ZONE,
        "results_kept" boolean NOT NULL DEFAULT true,
        "attached_organiser_user_ids" uuid[] NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_quizshow_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_quizshow_sessions_quiz" FOREIGN KEY ("quiz_id") REFERENCES "quizshow_quizzes"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_sessions_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_sessions_started_by" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quizshow_sessions_open_join_code" ON "quizshow_sessions" ("join_code") WHERE "status" IN ('lobby', 'running', 'paused')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quizshow_sessions_open_event" ON "quizshow_sessions" ("event_id") WHERE "status" IN ('lobby', 'running', 'paused')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_sessions_join_code_started_at" ON "quizshow_sessions" ("join_code", "started_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_sessions_status_ended_at" ON "quizshow_sessions" ("status", "ended_at")`,
    );
    // Every session of an event, open or ended: the kept-results reads and
    // the event delete cascade.
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_sessions_event_id" ON "quizshow_sessions" ("event_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_teams" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "name" character varying(40) NOT NULL,
        "color_key" "quizshow_team_color_key" NOT NULL,
        "score" integer NOT NULL DEFAULT 0,
        "has_used_joker" boolean NOT NULL DEFAULT false,
        "joker_round_index" integer,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quizshow_teams" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_teams_session_color" UNIQUE ("session_id", "color_key"),
        CONSTRAINT "FK_quizshow_teams_session" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quizshow_teams_session_name" ON "quizshow_teams" ("session_id", lower("name"))`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_players" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "is_cohost_player" boolean NOT NULL,
        "team_id" uuid,
        "screen_name" character varying(30) NOT NULL,
        "is_avatar_shown" boolean NOT NULL DEFAULT false,
        "has_extra_time" boolean NOT NULL DEFAULT false,
        "score" integer NOT NULL DEFAULT 0,
        "streak" integer NOT NULL DEFAULT 0,
        "has_used_joker" boolean NOT NULL DEFAULT false,
        "joker_round_index" integer,
        "removed_at" TIMESTAMP(3) WITH TIME ZONE,
        "joined_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_quizshow_players" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_players_session_user" UNIQUE ("session_id", "user_id"),
        CONSTRAINT "FK_quizshow_players_session" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_players_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_players_team" FOREIGN KEY ("team_id") REFERENCES "quizshow_teams"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_players_user_id" ON "quizshow_players" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_answers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "question_id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "received_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "elapsed_ms" integer,
        "is_correct" boolean,
        "points_awarded" integer NOT NULL DEFAULT 0,
        "vote_option_id" uuid,
        "hidden_at" TIMESTAMP(3) WITH TIME ZONE,
        "hidden_by_user_id" uuid,
        CONSTRAINT "PK_quizshow_answers" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_answers_player_question" UNIQUE ("player_id", "question_id"),
        CONSTRAINT "FK_quizshow_answers_session" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_answers_player" FOREIGN KEY ("player_id") REFERENCES "quizshow_players"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_answers_hidden_by" FOREIGN KEY ("hidden_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_answers_session_question" ON "quizshow_answers" ("session_id", "question_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_votes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "session_id" uuid NOT NULL,
        "question_id" uuid NOT NULL,
        "voter_player_id" uuid NOT NULL,
        "answer_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quizshow_votes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_quizshow_votes_voter_question" UNIQUE ("voter_player_id", "question_id"),
        CONSTRAINT "FK_quizshow_votes_session" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_votes_voter" FOREIGN KEY ("voter_player_id") REFERENCES "quizshow_players"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quizshow_votes_answer" FOREIGN KEY ("answer_id") REFERENCES "quizshow_answers"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    // The answer delete cascade and the session purge both look votes up by
    // these columns.
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_votes_answer_id" ON "quizshow_votes" ("answer_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_votes_session_id" ON "quizshow_votes" ("session_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_results" (
        "session_id" uuid NOT NULL,
        "podium" jsonb NOT NULL,
        "placings" jsonb NOT NULL,
        "question_stats" jsonb NOT NULL,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quizshow_results" PRIMARY KEY ("session_id"),
        CONSTRAINT "FK_quizshow_results_session" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const indexName of [
      'IDX_quizshow_votes_session_id',
      'IDX_quizshow_votes_answer_id',
      'IDX_quizshow_sessions_event_id',
    ]) {
      await queryRunner.query(`DROP INDEX "${indexName}"`);
    }
    for (const tableName of [
      'quizshow_results',
      'quizshow_votes',
      'quizshow_answers',
      'quizshow_players',
      'quizshow_teams',
      'quizshow_sessions',
      'quizshow_questions',
      'quizshow_rounds',
      'quizshow_quizzes',
    ]) {
      await queryRunner.query(`DROP TABLE "${tableName}"`);
    }
    for (const typeName of [
      'quizshow_team_color_key',
      'quizshow_play_mode',
      'quizshow_session_status',
      'quizshow_question_type',
      'quizshow_content_label',
      'quizshow_round_kind',
      'quizshow_language',
      'quizshow_language_mode',
    ]) {
      await queryRunner.query(`DROP TYPE "${typeName}"`);
    }
  }
}
