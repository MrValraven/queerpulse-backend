import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPartners1782693600000 implements MigrationInterface {
  name = 'AddPartners1782693600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "partners_region_enum" AS ENUM('pt', 'eu', 'int')`,
    );
    await queryRunner.query(
      `CREATE TYPE "partners_status_enum" AS ENUM('pending', 'approved', 'rejected')`,
    );

    await queryRunner.query(`
      CREATE TABLE "partners" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "logo" character varying NOT NULL,
        "region" "partners_region_enum" NOT NULL,
        "region_label" character varying NOT NULL,
        "city" character varying NOT NULL,
        "desc" text NOT NULL,
        "tags" text array NOT NULL DEFAULT '{}',
        "tier" character varying NOT NULL,
        "since" character varying NOT NULL,
        "eyebrow" character varying NOT NULL,
        "tagline" character varying NOT NULL,
        "about" jsonb NOT NULL DEFAULT '[]',
        "stats" jsonb NOT NULL DEFAULT '[]',
        "about_more" jsonb NOT NULL DEFAULT '[]',
        "joint_work" jsonb NOT NULL DEFAULT '[]',
        "timeline" jsonb NOT NULL DEFAULT '[]',
        "how" jsonb NOT NULL DEFAULT '[]',
        "funding" text NOT NULL,
        "at_glance" jsonb NOT NULL DEFAULT '[]',
        "contact" jsonb NOT NULL,
        "status" "partners_status_enum" NOT NULL DEFAULT 'pending',
        "submitted_by_id" uuid NOT NULL,
        "review_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_partners" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_partners_slug" ON "partners" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_partners_submitted_by_id" ON "partners" ("submitted_by_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "partners" ADD CONSTRAINT "FK_partners_submitted_by_id" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Deferred FK from Phase C: `volunteer_opportunities.partner_id` was added
    // as a nullable uuid column with NO constraint (the `partners` table
    // didn't exist yet — see `AddVolunteering1782693500000`). Now that it
    // does, wire the constraint up. `ON DELETE SET NULL` mirrors the
    // `partner_id` column's own nullability: deleting a partner un-links its
    // opportunities rather than cascading the delete into them.
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" ADD CONSTRAINT "FK_volunteer_opportunities_partner_id" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: the deferred FK into `volunteer_opportunities` first
    // (added last in `up()`), then `partners`' own FK, table, and enum types.
    await queryRunner.query(
      `ALTER TABLE "volunteer_opportunities" DROP CONSTRAINT "FK_volunteer_opportunities_partner_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" DROP CONSTRAINT "FK_partners_submitted_by_id"`,
    );

    await queryRunner.query(`DROP TABLE "partners"`);

    await queryRunner.query(`DROP TYPE "partners_status_enum"`);
    await queryRunner.query(`DROP TYPE "partners_region_enum"`);
  }
}
