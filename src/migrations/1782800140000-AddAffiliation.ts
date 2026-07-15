import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `affiliations` — a member's self-declared employer affiliation (plan Task
 * 2.4; spec §3 Tier 2 "affiliation"; backs `src/affiliation`). One row per
 * user (`UQ_affiliations_user_id`); FKs -> `users`/`companies`, both
 * `ON DELETE CASCADE` so a deleted user or company can't leave an orphaned
 * affiliation row. Mirrors `AddBlocksMutes1782800010000`'s table/index/FK
 * shape.
 *
 * NOT run as part of this task — the orchestrator sequences + runs it
 * against `_test`/dev DBs after wiring `AffiliationModule` into
 * `app.module.ts`.
 */
export class AddAffiliation1782800140000 implements MigrationInterface {
  name = 'AddAffiliation1782800140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "affiliation_status_enum" AS ENUM ('pending', 'active')
    `);

    await queryRunner.query(`
      CREATE TABLE "affiliations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "company_id" uuid NOT NULL,
        "role" character varying NOT NULL,
        "status" "affiliation_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_affiliations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_affiliations_user_id" ON "affiliations" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_affiliations_company_id" ON "affiliations" ("company_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "affiliations" ADD CONSTRAINT "FK_affiliations_user_id"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "affiliations" ADD CONSTRAINT "FK_affiliations_company_id"
        FOREIGN KEY ("company_id") REFERENCES "companies"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "affiliations" DROP CONSTRAINT "FK_affiliations_company_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "affiliations" DROP CONSTRAINT "FK_affiliations_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "affiliations"`);
    await queryRunner.query(`DROP TYPE "affiliation_status_enum"`);
  }
}
