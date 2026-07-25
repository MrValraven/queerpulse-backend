import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subprofiles Phase 3a: `subprofile_endorsements` — a persona-scoped mirror of
 * `vouches` (soft-withdraw, unique per persona+endorser). See
 * `src/subprofiles/entities/subprofile-endorsement.entity.ts`.
 */
export class AddSubprofileEndorsements1785000280000 implements MigrationInterface {
  name = 'AddSubprofileEndorsements1785000280000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subprofile_endorsements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "endorser_id" uuid NOT NULL,
        "note" text,
        "withdrawn_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_endorsements" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_subprofile_endorsements" UNIQUE ("subprofile_id", "endorser_id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_endorsements_subprofile_id" ON "subprofile_endorsements" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_endorsements_endorser_id" ON "subprofile_endorsements" ("endorser_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "subprofile_endorsements" ADD CONSTRAINT "FK_subprofile_endorsements_subprofile_id"
        FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "subprofile_endorsements" ADD CONSTRAINT "FK_subprofile_endorsements_endorser_id"
        FOREIGN KEY ("endorser_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofile_endorsements" DROP CONSTRAINT "FK_subprofile_endorsements_endorser_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subprofile_endorsements" DROP CONSTRAINT "FK_subprofile_endorsements_subprofile_id"`,
    );

    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_endorsements_endorser_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_subprofile_endorsements_subprofile_id"`,
    );

    await queryRunner.query(`DROP TABLE "subprofile_endorsements"`);
  }
}
