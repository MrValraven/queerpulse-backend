import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-08 / CON-09: makes the resource guides and the glossary editable, and
 * gives every guide a review date and an owner.
 *
 * Until now `resources` and `glossary_terms` were read-only tables with no
 * authoring endpoint, and the ~31 guide pages kept their prose in the
 * frontend i18n catalogs. This adds the columns the new
 * `AdminResourcesController` / `AdminGlossaryController` write:
 *
 *  - `sections` / `sections_pt` — the structured prose (see
 *    `resources/guide-section.ts`). An EMPTY `sections` array means the guide
 *    is not managed yet and the frontend keeps rendering its hardcoded page.
 *  - `title_pt` / `description_pt` — the Portuguese half of the card copy.
 *  - `route_path` — the frontend path the guide lives at, replacing the
 *    title-string guess the library grid used to build its links from.
 *  - `last_reviewed_on` / `reviewed_by` / `review_due_on` — the freshness
 *    signal a reader needs before trusting a hormone-access pathway, and the
 *    sort key for the admin "which guides are stale?" list.
 *  - `updated_by` — which staff account last wrote the row.
 *
 * The prose itself is backfilled by the separate data migration
 * `BackfillResourceGuides1794833210000`, which must run after this one.
 */
export class AddResourceGuideAuthoring1794833200000 implements MigrationInterface {
  name = 'AddResourceGuideAuthoring1794833200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "resources"
        ADD COLUMN "title_pt" character varying,
        ADD COLUMN "description_pt" text,
        ADD COLUMN "sections" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN "sections_pt" jsonb,
        ADD COLUMN "route_path" character varying,
        ADD COLUMN "review_due_on" date,
        ADD COLUMN "last_reviewed_on" date,
        ADD COLUMN "reviewed_by" character varying(120),
        ADD COLUMN "updated_by" uuid
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_resources_review_due_on" ON "resources" ("review_due_on")`,
    );

    await queryRunner.query(`
      ALTER TABLE "glossary_terms"
        ADD COLUMN "definition_pt" text,
        ADD COLUMN "review_due_on" date,
        ADD COLUMN "last_reviewed_on" date,
        ADD COLUMN "reviewed_by" character varying(120),
        ADD COLUMN "updated_by" uuid
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_glossary_terms_review_due_on" ON "glossary_terms" ("review_due_on")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_glossary_terms_review_due_on"`,
    );
    await queryRunner.query(`
      ALTER TABLE "glossary_terms"
        DROP COLUMN "updated_by",
        DROP COLUMN "reviewed_by",
        DROP COLUMN "last_reviewed_on",
        DROP COLUMN "review_due_on",
        DROP COLUMN "definition_pt"
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_resources_review_due_on"`,
    );
    await queryRunner.query(`
      ALTER TABLE "resources"
        DROP COLUMN "updated_by",
        DROP COLUMN "reviewed_by",
        DROP COLUMN "last_reviewed_on",
        DROP COLUMN "review_due_on",
        DROP COLUMN "route_path",
        DROP COLUMN "sections_pt",
        DROP COLUMN "sections",
        DROP COLUMN "description_pt",
        DROP COLUMN "title_pt"
    `);
  }
}
