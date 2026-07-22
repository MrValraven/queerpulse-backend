import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `changemaker` (the curated directory profiles) and
 * `changemaker_directory_settings` (the two admin-set hero stats), backing the
 * real-data Change Makers feature. See
 * `queerpulse/docs/superpowers/specs/2026-07-22-changemakers-real-data-design.md`.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddChangemakers1785000000000 implements MigrationInterface {
  name = 'AddChangemakers1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "changemaker" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying(200) NOT NULL,
        "name" character varying(200) NOT NULL,
        "initials" character varying(12) NOT NULL,
        "cause" character varying(120) NOT NULL,
        "tint" character varying(12) NOT NULL DEFAULT 'plum',
        "tags" jsonb NOT NULL DEFAULT '[]',
        "summary" text NOT NULL,
        "image_url" character varying(500),
        "impact" jsonb NOT NULL DEFAULT '[]',
        "byline" character varying(200) NOT NULL DEFAULT '',
        "hero_note" character varying(300) NOT NULL DEFAULT '',
        "lead" text NOT NULL DEFAULT '',
        "body" jsonb NOT NULL DEFAULT '[]',
        "pull_quote_text" text NOT NULL DEFAULT '',
        "pull_quote_cite" character varying(200) NOT NULL DEFAULT '',
        "status" character varying(20) NOT NULL DEFAULT 'draft',
        "is_featured" boolean NOT NULL DEFAULT false,
        "sort_order" integer NOT NULL DEFAULT 0,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_changemaker" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_changemaker_slug" ON "changemaker" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_changemaker_status" ON "changemaker" ("status")`,
    );
    await queryRunner.query(`
      CREATE TABLE "changemaker_directory_settings" (
        "id" character varying(20) NOT NULL,
        "people_helped" integer NOT NULL DEFAULT 0,
        "active_campaigns" integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_changemaker_directory_settings" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "changemaker_directory_settings"`);
    await queryRunner.query(`DROP INDEX "IDX_changemaker_status"`);
    await queryRunner.query(`DROP INDEX "IDX_changemaker_slug"`);
    await queryRunner.query(`DROP TABLE "changemaker"`);
  }
}
