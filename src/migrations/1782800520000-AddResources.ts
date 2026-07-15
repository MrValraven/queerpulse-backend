import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `resources` module's schema (Task 5.2 — `resources` feature):
 * a read-only guide directory (`resources`) and glossary (`glossary_terms`),
 * both seeded from the frontend's `queerpulse/src/features/resources/` mock
 * (see `src/resources/resources.seed.ts`) with no authoring endpoint.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddResources1782800520000 implements MigrationInterface {
  name = 'AddResources1782800520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "resources" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "category" character varying NOT NULL,
        "title" character varying NOT NULL,
        "description" text NOT NULL,
        "body" text NOT NULL,
        "meta" character varying,
        "external_url" character varying,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resources" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_resources_slug" ON "resources" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_resources_category" ON "resources" ("category")`,
    );

    await queryRunner.query(`
      CREATE TABLE "glossary_terms" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "term" character varying NOT NULL,
        "definition" text NOT NULL,
        "category" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_glossary_terms" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_glossary_terms_slug" ON "glossary_terms" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_glossary_terms_category" ON "glossary_terms" ("category")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "glossary_terms"`);
    await queryRunner.query(`DROP TABLE "resources"`);
  }
}
