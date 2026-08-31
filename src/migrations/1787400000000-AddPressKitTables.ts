import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two admin-curated press-kit lists shown on the public
 * `/about/press-kit` page: `press_coverage` (headlines about QueerPulse in
 * outside publications) and `press_contact` (who a journalist can reach). Each
 * row carries a `position` and an `active` flag — the public read filters to
 * active and orders by position, the admin surface sees every row. The page's
 * headline FACTS are derived from live DB counts at read time and are NOT
 * stored, so no table is added for them.
 */
export class AddPressKitTables1787400000000 implements MigrationInterface {
  name = 'AddPressKitTables1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "press_coverage" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "source" character varying NOT NULL,
        "title" character varying NOT NULL,
        "meta" character varying NOT NULL,
        "published_on" character varying NOT NULL,
        "url" character varying,
        "position" integer NOT NULL DEFAULT 0,
        "active" boolean NOT NULL DEFAULT true,
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_press_coverage" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_press_coverage_active_position" ON "press_coverage" ("active", "position")`,
    );

    await queryRunner.query(`
      CREATE TABLE "press_contact" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "role" character varying NOT NULL,
        "description" text NOT NULL,
        "languages" character varying NOT NULL,
        "email" character varying NOT NULL,
        "avatar_url" character varying,
        "position" integer NOT NULL DEFAULT 0,
        "active" boolean NOT NULL DEFAULT true,
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_press_contact" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_press_contact_active_position" ON "press_contact" ("active", "position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_press_contact_active_position"`);
    await queryRunner.query(`DROP TABLE "press_contact"`);
    await queryRunner.query(`DROP INDEX "IDX_press_coverage_active_position"`);
    await queryRunner.query(`DROP TABLE "press_coverage"`);
  }
}
