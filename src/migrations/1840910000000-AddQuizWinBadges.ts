// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quiz win badges: staff keep a library of badges, attach up to three per game
 * to games 1 to 5 of an event, and the server records the winners of every
 * numbered event game and awards the attached badges. Four new tables
 * (`quiz_badge_definitions`, `quiz_event_badge_slots`, `quiz_game_winners`,
 * `quiz_badge_wins`) and one `quizshow_sessions` column, `event_game_number`,
 * with its check and its partial unique index.
 *
 * This migration adds no enum label, so the default migration transaction
 * stays. Nothing is backfilled: sessions finished before it keep a null game
 * number, and no winner or win row is written for them. Quiz badge awards reuse
 * `recognition_awards` with the key `quiz:<definition id>`, so that table
 * changes nothing.
 *
 * Indexes and the reads they back:
 * - `UQ_quiz_badge_definitions_badge_key` serves the award key lookup, and the
 *   two expression indexes `UQ_quiz_badge_definitions_name_en` and
 *   `UQ_quiz_badge_definitions_name_pt` keep each language name unique ignoring
 *   case (migration only, TypeORM metadata cannot express `lower()`).
 * - `UQ_quiz_event_badge_slots_event_game_badge` serves the slot list of one
 *   game and keeps each badge once per game,
 *   `IDX_quiz_event_badge_slots_badge_definition_id` serves the definition
 *   usage count and backs its `ON DELETE RESTRICT` key.
 * - `UQ_quiz_game_winners_session_user` is the recording insert's
 *   `ON CONFLICT DO NOTHING` target, `IDX_quiz_game_winners_event_game` serves
 *   the winner list of one game, and `IDX_quiz_game_winners_user_id` serves the
 *   member export and the account erasure cascade.
 * - `UQ_quiz_badge_wins_session_badge_user` is the awarding insert's
 *   idempotency target, `IDX_quiz_badge_wins_user_badge` serves the member
 *   badge read and its win count, and `IDX_quiz_badge_wins_badge_definition_id`
 *   serves the definition usage count and backs its `ON DELETE RESTRICT` key.
 * - `UQ_quizshow_sessions_event_game_number` serves the game number read of one
 *   event and backs the finish write that stamps the next number.
 * - The partial `created_by_id`, `revoked_by_id` and `event_id` indexes back
 *   their `ON DELETE SET NULL` keys.
 *
 * Every table is new, so its indexes build empty inside the migration
 * transaction. The `quizshow_sessions` column is added with every row null, so
 * the partial unique index starts empty.
 */
export class AddQuizWinBadges1840910000000 implements MigrationInterface {
  name = 'AddQuizWinBadges1840910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "quiz_badge_definitions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "badge_key" character varying(48) NOT NULL,
        "name_en" character varying(40) NOT NULL,
        "name_pt" character varying(40),
        "description_en" character varying(140) NOT NULL,
        "description_pt" character varying(140),
        "icon_key" character varying(32) NOT NULL,
        "tint" character varying(16) NOT NULL,
        "rarity" character varying(16) NOT NULL,
        "archived_at" TIMESTAMP WITH TIME ZONE,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quiz_badge_definitions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_quiz_badge_definitions_badge_key" CHECK ("badge_key" = 'quiz:' || "id"::text),
        CONSTRAINT "CHK_quiz_badge_definitions_tint" CHECK ("tint" IN ('jade', 'accent', 'plum')),
        CONSTRAINT "CHK_quiz_badge_definitions_rarity" CHECK ("rarity" IN ('common', 'rare', 'legendary')),
        CONSTRAINT "FK_quiz_badge_definitions_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_badge_definitions_badge_key" ON "quiz_badge_definitions" ("badge_key")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_badge_definitions_name_en" ON "quiz_badge_definitions" (lower("name_en"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_badge_definitions_name_pt" ON "quiz_badge_definitions" (lower("name_pt")) WHERE "name_pt" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_badge_definitions_created_by_id" ON "quiz_badge_definitions" ("created_by_id") WHERE "created_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "quiz_event_badge_slots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid NOT NULL,
        "game_number" integer NOT NULL,
        "badge_definition_id" uuid NOT NULL,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quiz_event_badge_slots" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_quiz_event_badge_slots_game_number" CHECK ("game_number" BETWEEN 1 AND 5),
        CONSTRAINT "FK_quiz_event_badge_slots_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_event_badge_slots_badge_definition_id" FOREIGN KEY ("badge_definition_id") REFERENCES "quiz_badge_definitions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_event_badge_slots_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_event_badge_slots_event_game_badge" ON "quiz_event_badge_slots" ("event_id", "game_number", "badge_definition_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_event_badge_slots_badge_definition_id" ON "quiz_event_badge_slots" ("badge_definition_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_event_badge_slots_created_by_id" ON "quiz_event_badge_slots" ("created_by_id") WHERE "created_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "quiz_game_winners" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "event_id" uuid,
        "session_id" uuid,
        "game_number" integer NOT NULL,
        "finished_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "user_id" uuid NOT NULL,
        "screen_name" character varying(30) NOT NULL,
        "team_name" character varying(40),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_id" uuid,
        "revoke_reason" character varying(300),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quiz_game_winners" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_quiz_game_winners_game_number" CHECK ("game_number" >= 1),
        CONSTRAINT "CHK_quiz_game_winners_revoke" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
        CONSTRAINT "FK_quiz_game_winners_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_game_winners_session_id" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_game_winners_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_game_winners_revoked_by_id" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_game_winners_session_user" ON "quiz_game_winners" ("session_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_game_winners_event_game" ON "quiz_game_winners" ("event_id", "game_number")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_game_winners_user_id" ON "quiz_game_winners" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_game_winners_revoked_by_id" ON "quiz_game_winners" ("revoked_by_id") WHERE "revoked_by_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "quiz_badge_wins" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "badge_definition_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "event_id" uuid,
        "session_id" uuid,
        "game_number" integer NOT NULL,
        "event_name_snapshot" text NOT NULL,
        "event_was_public" boolean NOT NULL,
        "event_was_adults_only" boolean NOT NULL,
        "won_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quiz_badge_wins" PRIMARY KEY ("id"),
        CONSTRAINT "FK_quiz_badge_wins_badge_definition_id" FOREIGN KEY ("badge_definition_id") REFERENCES "quiz_badge_definitions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_badge_wins_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_badge_wins_event_id" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_quiz_badge_wins_session_id" FOREIGN KEY ("session_id") REFERENCES "quizshow_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quiz_badge_wins_session_badge_user" ON "quiz_badge_wins" ("session_id", "badge_definition_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_badge_wins_user_badge" ON "quiz_badge_wins" ("user_id", "badge_definition_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_badge_wins_badge_definition_id" ON "quiz_badge_wins" ("badge_definition_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quiz_badge_wins_event_id" ON "quiz_badge_wins" ("event_id") WHERE "event_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" ADD "event_game_number" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" ADD CONSTRAINT "CHK_quizshow_sessions_event_game_number" CHECK ("event_game_number" IS NULL OR "event_game_number" >= 1)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quizshow_sessions_event_game_number" ON "quizshow_sessions" ("event_id", "event_game_number") WHERE "event_game_number" IS NOT NULL`,
    );
  }

  /**
   * The award rows of the `quiz:` keys go first, so no award key outlives the
   * definitions it names. Then the four tables drop children first, and the
   * session index, check and column follow.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "recognition_awards" WHERE "badge_key" LIKE 'quiz:%'`,
    );
    await queryRunner.query(`DROP TABLE "quiz_badge_wins"`);
    await queryRunner.query(`DROP TABLE "quiz_game_winners"`);
    await queryRunner.query(`DROP TABLE "quiz_event_badge_slots"`);
    await queryRunner.query(`DROP TABLE "quiz_badge_definitions"`);
    await queryRunner.query(
      `DROP INDEX "UQ_quizshow_sessions_event_game_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" DROP CONSTRAINT "CHK_quizshow_sessions_event_game_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" DROP COLUMN "event_game_number"`,
    );
  }
}
