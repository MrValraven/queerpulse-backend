import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CNT-14: real admin-curated directories for Legal Aid / Sexual Health
 * Testing (`resource_listing`) plus the public "suggest a resource"
 * submission pathway that feeds an admin review queue (`resource_suggestion`).
 * Deliberately separate tables, mirroring `reading_group_proposal`'s split
 * from its curated content: `resource_listing` is staff-authored and vetted,
 * `resource_suggestion` is member-authored and unverified. Approving a
 * suggestion never auto-creates a listing (see
 * `AdminResourceSuggestionsService.approve`) — the two tables share no FK
 * between each other on purpose.
 *
 * `category` uses ONE shared enum type across both tables (the same real-world
 * categories apply to a listing and the suggestion that might become one).
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddResourceListingsAndSuggestions1793000000000
  implements MigrationInterface
{
  name = 'AddResourceListingsAndSuggestions1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "resource_listing_category_enum" AS ENUM (
        'legal_aid', 'sexual_health_testing'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "resource_listing_status_enum" AS ENUM (
        'active', 'archived'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "resource_suggestion_status_enum" AS ENUM (
        'pending', 'approved', 'declined', 'archived'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "resource_listing" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "category" "resource_listing_category_enum" NOT NULL,
        "title" character varying(200) NOT NULL,
        "description" text NOT NULL,
        "phone" character varying(40),
        "email" character varying(320),
        "website" character varying(500),
        "region" character varying(200),
        "status" "resource_listing_status_enum" NOT NULL DEFAULT 'active',
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_listing" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_resource_listing_category" ON "resource_listing" ("category")`,
    );

    await queryRunner.query(`
      CREATE TABLE "resource_suggestion" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "member_id" uuid NOT NULL,
        "category" "resource_listing_category_enum" NOT NULL,
        "name" character varying(200) NOT NULL,
        "description" text NOT NULL,
        "phone" character varying(40),
        "email" character varying(320),
        "website" character varying(500),
        "status" "resource_suggestion_status_enum" NOT NULL DEFAULT 'pending',
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "decided_by" uuid,
        "decision_note" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_suggestion" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_resource_suggestion_member_id" ON "resource_suggestion" ("member_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_resource_suggestion_category" ON "resource_suggestion" ("category")`,
    );
    await queryRunner.query(`
      ALTER TABLE "resource_suggestion" ADD CONSTRAINT "FK_resource_suggestion_member_id"
        FOREIGN KEY ("member_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "resource_suggestion" DROP CONSTRAINT "FK_resource_suggestion_member_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_resource_suggestion_category"`);
    await queryRunner.query(`DROP INDEX "IDX_resource_suggestion_member_id"`);
    await queryRunner.query(`DROP TABLE "resource_suggestion"`);

    await queryRunner.query(`DROP INDEX "IDX_resource_listing_category"`);
    await queryRunner.query(`DROP TABLE "resource_listing"`);

    await queryRunner.query(`DROP TYPE "resource_suggestion_status_enum"`);
    await queryRunner.query(`DROP TYPE "resource_listing_status_enum"`);
    await queryRunner.query(`DROP TYPE "resource_listing_category_enum"`);
  }
}
