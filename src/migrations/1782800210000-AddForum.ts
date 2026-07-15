import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_thread` / `forum_post` / `forum_post_vote` backing `src/forum`
 * (spec §3 Tier 3 "forum"). Mirrors `AddCommunities1782693200000`'s
 * table/index/FK shape. Table names are singular per the task brief
 * (`forum_thread`, not `forum_threads`) — a deliberate exception to the
 * repo's usual pluralized table-name convention.
 *
 * NOT run as part of this task — the orchestrator sequences + runs it
 * against `_test`/dev DBs after wiring `ForumModule` into `app.module.ts`.
 */
export class AddForum1782800210000 implements MigrationInterface {
  name = 'AddForum1782800210000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "forum_thread" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "title" character varying NOT NULL,
        "author_id" uuid NOT NULL,
        "category" character varying NOT NULL,
        "is_pinned" boolean NOT NULL DEFAULT false,
        "is_locked" boolean NOT NULL DEFAULT false,
        "reply_count" integer NOT NULL DEFAULT 0,
        "last_activity_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_thread" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_forum_thread_slug" ON "forum_thread" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_author_id" ON "forum_thread" ("author_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_category" ON "forum_thread" ("category")`,
    );
    // Supports `GET /forum/threads?category=&cursor=`'s keyset predicate —
    // `cursorPaginate` (src/common/cursor-pagination.ts) orders
    // `(created_at, id) DESC`.
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_created_at_id" ON "forum_thread" ("created_at" DESC, "id" DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE "forum_post" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "thread_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "vote_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_post" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_post_author_id" ON "forum_post" ("author_id")`,
    );
    // Supports `GET /forum/threads/:slug/posts?cursor=`'s thread-scoped
    // oldest-first keyset predicate (`(created_at, id) ASC` — see
    // `ForumPostsService.paginateOldestFirst`).
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_post_thread_id_created_at_id" ON "forum_post" ("thread_id", "created_at", "id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "forum_post_vote" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "value" smallint NOT NULL,
        CONSTRAINT "PK_forum_post_vote" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forum_post_vote" UNIQUE ("post_id", "user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_post_vote_user_id" ON "forum_post_vote" ("user_id")`,
    );

    // Foreign keys
    await queryRunner.query(`
      ALTER TABLE "forum_thread" ADD CONSTRAINT "FK_forum_thread_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_post" ADD CONSTRAINT "FK_forum_post_thread_id"
        FOREIGN KEY ("thread_id") REFERENCES "forum_thread"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_post" ADD CONSTRAINT "FK_forum_post_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_post_vote" ADD CONSTRAINT "FK_forum_post_vote_post_id"
        FOREIGN KEY ("post_id") REFERENCES "forum_post"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_post_vote" ADD CONSTRAINT "FK_forum_post_vote_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post_vote" DROP CONSTRAINT "FK_forum_post_vote_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post_vote" DROP CONSTRAINT "FK_forum_post_vote_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP CONSTRAINT "FK_forum_post_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP CONSTRAINT "FK_forum_post_thread_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP CONSTRAINT "FK_forum_thread_author_id"`,
    );

    await queryRunner.query(`DROP TABLE "forum_post_vote"`);
    await queryRunner.query(`DROP TABLE "forum_post"`);
    await queryRunner.query(`DROP TABLE "forum_thread"`);
  }
}
