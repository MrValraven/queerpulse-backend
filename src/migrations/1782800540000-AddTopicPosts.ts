import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `content` module's `topic_post` table — the post feed under a
 * topic (`GET /topics/:slug/posts`), which `1782800530000-AddContentPages`'s
 * `topics` table deliberately left out. Also adds `topics.follower_count`,
 * the "Members following" stat `GET /topics/:slug` now returns.
 *
 * See `src/content/entities/topic-post.entity.ts` for why this is a
 * dedicated table rather than an aggregation over `forum_thread` /
 * `community_post` / `event` by a shared tag column.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddTopicPosts1782800540000 implements MigrationInterface {
  name = 'AddTopicPosts1782800540000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topics" ADD "follower_count" integer NOT NULL DEFAULT 0`,
    );

    await queryRunner.query(`
      CREATE TABLE "topic_post" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "topic_id" uuid NOT NULL,
        "author_name" character varying NOT NULL,
        "author_initials" character varying NOT NULL,
        "author_tone" character varying NOT NULL,
        "context_label" character varying,
        "kind" character varying NOT NULL,
        "category" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "reaction_count" integer NOT NULL DEFAULT 0,
        "reaction_label" character varying NOT NULL,
        "reply_count" integer NOT NULL DEFAULT 0,
        "reply_label" character varying,
        "tags" text[] NOT NULL DEFAULT '{}',
        "href" character varying NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topic_post" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_post_topic_id" ON "topic_post" ("topic_id")`,
    );
    // Supports `GET /topics/:slug/posts?cursor=`'s topic-scoped keyset
    // predicate — `cursorPaginate` (src/common/cursor-pagination.ts) orders
    // `(created_at, id) DESC`.
    await queryRunner.query(
      `CREATE INDEX "IDX_topic_post_topic_id_created_at_id" ON "topic_post" ("topic_id", "created_at" DESC, "id" DESC)`,
    );

    await queryRunner.query(`
      ALTER TABLE "topic_post" ADD CONSTRAINT "FK_topic_post_topic_id"
        FOREIGN KEY ("topic_id") REFERENCES "topics"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_post" DROP CONSTRAINT "FK_topic_post_topic_id"`,
    );
    await queryRunner.query(`DROP TABLE "topic_post"`);
    await queryRunner.query(`ALTER TABLE "topics" DROP COLUMN "follower_count"`);
  }
}
