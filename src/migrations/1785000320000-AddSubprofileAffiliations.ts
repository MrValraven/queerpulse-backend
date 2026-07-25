import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subprofiles Phase 3c: `subprofile_affiliations` — lets a persona owner link
 * existing events/communities (with a preset role + display position) shown
 * as a "Part of" section on the persona page. See
 * `src/subprofiles/entities/subprofile-affiliation.entity.ts`.
 */
export class AddSubprofileAffiliations1785000320000 implements MigrationInterface {
  name = 'AddSubprofileAffiliations1785000320000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_affiliations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "target_type" varchar NOT NULL,
        "target_slug" varchar NOT NULL,
        "role" varchar NOT NULL,
        "position" int NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_affiliations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_affiliations" UNIQUE ("subprofile_id", "target_type", "target_slug")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_affiliations_subprofile_id" ON "subprofile_affiliations" ("subprofile_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "subprofile_affiliations" ADD CONSTRAINT "FK_subprofile_affiliations_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_affiliations" DROP CONSTRAINT "FK_subprofile_affiliations_subprofile_id"`,
    );

    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_affiliations_subprofile_id"`,
    );

    await queryRunner.query(`DROP TABLE "subprofile_affiliations"`);
  }
}
