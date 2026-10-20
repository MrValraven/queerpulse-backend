// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pulse Live (code id `quizshow`) games without an event: a member owns a
 * quiz directly and runs sessions of it with no event. A forward migration
 * because `AddQuizshow1836000100000` already ran in production; the final
 * schema matches the entities in `src/quizshow/entities` and is covered by
 * `src/database/quizshow-migrations.postgres.spec.ts`.
 *
 * Retention rules the new keys carry:
 * - a quiz belongs to exactly one of an event or its owner
 *   (`CHK_quizshow_quizzes_scope`); a quiz owned by a member is a game;
 * - a game lives until its owner deletes it or the owner's account goes
 *   (owner cascade); an event quiz still goes with its event;
 * - sessions follow the quiz and, when they have one, the event; a game
 *   session has no event.
 *
 * At most one open session (lobby, running, paused) exists per quiz, enforced
 * by `UQ_quizshow_sessions_open_quiz` beside the join code and event indexes
 * `AddQuizshow1836000100000` created. The lobby-open rate limit counts
 * `quizshow_lobby_opens`, a per-member ledger with no key to quizzes or
 * sessions, so the count survives a deleted game; its rows cascade with the
 * member's account.
 *
 * The feature has not launched, so the quizshow tables are tiny and every
 * index builds inside the migration transaction.
 */
export class AddQuizshowGames1837000100000 implements MigrationInterface {
  name = 'AddQuizshowGames1837000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ALTER COLUMN "event_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD "owner_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD "is_adults_only" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "FK_quizshow_quizzes_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ADD CONSTRAINT "CHK_quizshow_quizzes_scope" CHECK (num_nonnulls("event_id", "owner_user_id") = 1)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_quizzes_owner_user_id" ON "quizshow_quizzes" ("owner_user_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" ALTER COLUMN "event_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_quizshow_sessions_open_quiz" ON "quizshow_sessions" ("quiz_id") WHERE "status" IN ('lobby', 'running', 'paused')`,
    );
    // Sessions opened by one member over time: serves the opener's account
    // deletion (`ON DELETE SET NULL`); the rate limit reads `quizshow_lobby_opens`.
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_sessions_started_by_started_at" ON "quizshow_sessions" ("started_by_user_id", "started_at")`,
    );
    // Every session of a quiz: a game reads its kept results by quiz id and
    // the game delete cascades through it.
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_sessions_quiz_id" ON "quizshow_sessions" ("quiz_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "quizshow_lobby_opens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "opened_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_quizshow_lobby_opens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_quizshow_lobby_opens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_quizshow_lobby_opens_user_opened" ON "quizshow_lobby_opens" ("user_id", "opened_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_quizshow_lobby_opens_user_opened"`,
    );
    await queryRunner.query(`DROP TABLE "quizshow_lobby_opens"`);

    for (const indexName of [
      'IDX_quizshow_sessions_quiz_id',
      'IDX_quizshow_sessions_started_by_started_at',
      'UQ_quizshow_sessions_open_quiz',
      'IDX_quizshow_quizzes_owner_user_id',
    ]) {
      await queryRunner.query(`DROP INDEX "${indexName}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "CHK_quizshow_quizzes_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP CONSTRAINT "FK_quizshow_quizzes_owner"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP COLUMN "is_adults_only"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" DROP COLUMN "owner_user_id"`,
    );

    // Restoring NOT NULL only succeeds while no game and no game session
    // exists: their `event_id` is null, so `SET NOT NULL` correctly fails and
    // the transaction rolls the whole revert back. Games are members' own
    // content, so down() deletes nothing and leaves those rows for the
    // maintainer to decide on.
    await queryRunner.query(
      `ALTER TABLE "quizshow_sessions" ALTER COLUMN "event_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "quizshow_quizzes" ALTER COLUMN "event_id" SET NOT NULL`,
    );
  }
}
