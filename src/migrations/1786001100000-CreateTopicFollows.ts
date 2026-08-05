import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `topic_follows` — one row per member "following" a topic (P2-15). Topics
 * have no backend table (they are frontend-derived by tag/slug and served
 * read-side by the `content` module), so the follow is keyed by the topic's
 * public `topic_slug` varchar rather than an FK to a topics table. Only the
 * `user_id` FK cascades on delete (a user's follows die with the user).
 *
 * `UQ_topic_follows (user_id, topic_slug)` makes following idempotent at the DB
 * level, so a double-tap is absorbed by `ON CONFLICT DO NOTHING` rather than
 * raising 23505. The composite unique already leads with `user_id`, so it also
 * covers the "which topics does this user follow?" read; `IDX_topic_follows_user_id`
 * is added as the explicit single-column index the P2-15 spec calls for.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class CreateTopicFollows1786001100000 implements MigrationInterface {
  name = 'CreateTopicFollows1786001100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "topic_follows" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "topic_slug" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_follows" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_topic_follows" UNIQUE ("user_id", "topic_slug")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_follows_user_id" ON "topic_follows" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_follows" ADD CONSTRAINT "FK_topic_follows_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_follows" DROP CONSTRAINT "FK_topic_follows_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_topic_follows_user_id"`);
    await queryRunner.query(`DROP TABLE "topic_follows"`);
  }
}
