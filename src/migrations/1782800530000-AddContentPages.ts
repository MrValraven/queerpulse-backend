import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `content` module's schema (Task 5.3 — generic slug CMS): a
 * read-only page directory (`content_pages`) serving the frontend's
 * `culture`/`support`/`governance` features as `PageResponse`, plus a
 * separate `topics` directory for the `topics` feature's hashtag list (see
 * `src/content/entities/topic.entity.ts` for why it isn't a `content_pages`
 * row). Both are seeded from the frontend mock (see `src/content/content.seed.ts`)
 * with no authoring endpoint.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddContentPages1782800530000 implements MigrationInterface {
  name = 'AddContentPages1782800530000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "content_pages_section_enum" AS ENUM('culture', 'support', 'governance')`,
    );

    await queryRunner.query(`
      CREATE TABLE "content_pages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "section" "content_pages_section_enum" NOT NULL,
        "slug" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "locale" character varying NOT NULL DEFAULT 'en',
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_content_pages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_content_pages_section_slug" ON "content_pages" ("section", "slug")`,
    );

    await queryRunner.query(`
      CREATE TABLE "topics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tag" character varying NOT NULL,
        "label" character varying NOT NULL,
        "description" text NOT NULL,
        "total_posts" integer NOT NULL DEFAULT 0,
        "crisis_card" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_topics" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_topics_tag" ON "topics" ("tag")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "topics"`);
    await queryRunner.query(`DROP TABLE "content_pages"`);
    await queryRunner.query(`DROP TYPE "content_pages_section_enum"`);
  }
}
