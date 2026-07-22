import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `housing_coops` (the housing co-op directory listings) and
 * `coop_join_requests` (interest/join submissions against a co-op), backing
 * the Housing Co-ops feature. Co-ops start empty by design — this migration
 * creates no seed rows.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddHousing1785000010000 implements MigrationInterface {
  name = 'AddHousing1785000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "housing_coops_phase_enum" AS ENUM('forming','legal','finance','property','daily')`,
    );
    await queryRunner.query(
      `CREATE TYPE "housing_coops_cta_kind_enum" AS ENUM('join','updates','mentor')`,
    );
    await queryRunner.query(
      `CREATE TYPE "coop_join_requests_status_enum" AS ENUM('pending','accepted','declined')`,
    );
    await queryRunner.query(
      `CREATE TABLE "housing_coops" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        "name_em" character varying,
        "city" character varying NOT NULL,
        "area" character varying NOT NULL,
        "household_count" integer NOT NULL DEFAULT 0,
        "phase" "housing_coops_phase_enum" NOT NULL DEFAULT 'forming',
        "progress" integer NOT NULL DEFAULT 0,
        "operational" boolean NOT NULL DEFAULT false,
        "operational_since" date,
        "forming_since" date,
        "description" text NOT NULL,
        "share_amount_euros" integer,
        "monthly_euros" integer,
        "shares_are_target" boolean NOT NULL DEFAULT false,
        "cta_kind" "housing_coops_cta_kind_enum" NOT NULL DEFAULT 'join',
        "faces" jsonb NOT NULL DEFAULT '[]',
        "published" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_coops" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_coops_slug" ON "housing_coops" ("slug")`,
    );
    await queryRunner.query(
      `CREATE TABLE "coop_join_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "coop_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "household_size" character varying NOT NULL,
        "note" text,
        "user_id" uuid,
        "status" "coop_join_requests_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coop_join_requests" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_join_requests_coop_id" ON "coop_join_requests" ("coop_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_join_requests" ADD CONSTRAINT "FK_coop_join_requests_coop_id" FOREIGN KEY ("coop_id") REFERENCES "housing_coops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "coop_join_requests" DROP CONSTRAINT "FK_coop_join_requests_coop_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_coop_join_requests_coop_id"`);
    await queryRunner.query(`DROP TABLE "coop_join_requests"`);
    await queryRunner.query(`DROP INDEX "UQ_housing_coops_slug"`);
    await queryRunner.query(`DROP TABLE "housing_coops"`);
    await queryRunner.query(`DROP TYPE "coop_join_requests_status_enum"`);
    await queryRunner.query(`DROP TYPE "housing_coops_cta_kind_enum"`);
    await queryRunner.query(`DROP TYPE "housing_coops_phase_enum"`);
  }
}
