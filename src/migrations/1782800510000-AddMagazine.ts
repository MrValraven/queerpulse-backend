import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `magazine` module's schema (Task 5.1 — `magazine` feature): a
 * read-only editorial CMS (curated authors, issues, articles) plus one write
 * — reader story submissions — backing `src/magazine`. Seeded from the
 * frontend's `queerpulse/src/features/magazine/` mock (see
 * `src/magazine/magazine.seed.ts`); no authoring/admin CRUD endpoint exists
 * for editorial content (spec §3 Tier 5 note).
 *
 * Table names are domain-prefixed (`magazine_author`, `magazine_issue`,
 * `magazine_article`, `magazine_story_submission`) rather than the task
 * brief's bare `author`/`issue`/`article`/`story_submission` — those four
 * nouns are generic enough to collide with an unrelated future module's own
 * concept of the same name. Mirrors `AddForum1782800210000`'s identical
 * deliberate deviation (`forum_thread`/`forum_post`/`forum_post_vote`, not
 * bare `thread`/`post`).
 *
 * NOT run as part of this task — the orchestrator sequences + runs it
 * against `_test`/dev DBs after wiring `MagazineModule` into `app.module.ts`.
 */
export class AddMagazine1782800510000 implements MigrationInterface {
  name = 'AddMagazine1782800510000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "magazine_submission_status_enum" AS ENUM('draft', 'submitted', 'in_review', 'accepted', 'rejected', 'published')`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_author" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "bio" text,
        "avatar_url" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_author" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_author_slug" ON "magazine_author" ("slug")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_issue" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "number" character varying NOT NULL,
        "title" character varying NOT NULL,
        "dek" text NOT NULL,
        "published_on" date NOT NULL,
        "cover_url" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_issue" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_issue_number" ON "magazine_issue" ("number")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_article" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "title" character varying NOT NULL,
        "dek" text NOT NULL,
        "body" text NOT NULL,
        "author_id" uuid NOT NULL,
        "issue_id" uuid,
        "tags" text[] NOT NULL DEFAULT '{}',
        "read_minutes" integer NOT NULL,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_article" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_magazine_article_slug" ON "magazine_article" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_author_id" ON "magazine_article" ("author_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_issue_id" ON "magazine_article" ("issue_id")`,
    );
    // Supports `GET /magazine/articles?tag=`'s `:tag = ANY(article.tags)`
    // predicate (see `MagazineService.listArticles`).
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_tags" ON "magazine_article" USING GIN ("tags")`,
    );

    await queryRunner.query(`
      CREATE TABLE "magazine_story_submission" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "format" character varying NOT NULL,
        "working_title" character varying NOT NULL,
        "pitch" text NOT NULL,
        "status" "magazine_submission_status_enum" NOT NULL DEFAULT 'submitted',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_story_submission" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_story_submission_user_id" ON "magazine_story_submission" ("user_id")`,
    );

    // Foreign keys
    await queryRunner.query(`
      ALTER TABLE "magazine_article" ADD CONSTRAINT "FK_magazine_article_author_id"
        FOREIGN KEY ("author_id") REFERENCES "magazine_author"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "magazine_article" ADD CONSTRAINT "FK_magazine_article_issue_id"
        FOREIGN KEY ("issue_id") REFERENCES "magazine_issue"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "magazine_story_submission" ADD CONSTRAINT "FK_magazine_story_submission_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_story_submission" DROP CONSTRAINT "FK_magazine_story_submission_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "FK_magazine_article_issue_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP CONSTRAINT "FK_magazine_article_author_id"`,
    );

    await queryRunner.query(`DROP TABLE "magazine_story_submission"`);
    await queryRunner.query(`DROP TABLE "magazine_article"`);
    await queryRunner.query(`DROP TABLE "magazine_issue"`);
    await queryRunner.query(`DROP TABLE "magazine_author"`);

    await queryRunner.query(`DROP TYPE "magazine_submission_status_enum"`);
  }
}
