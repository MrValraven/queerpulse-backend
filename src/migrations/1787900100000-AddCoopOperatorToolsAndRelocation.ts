import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Co-living operator tools (P3.2): adds the operator-identity-verified marker
 * to `housing_coops` and the `coop_relocation_requests` conflict-resolution /
 * relocation flow (a member flags a serious household conflict; an operator or
 * steward logs the relocation outcome).
 *
 * Additive and safe: the new column defaults to false; the new table is empty.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddCoopOperatorToolsAndRelocation1787900100000 implements MigrationInterface {
  name = 'AddCoopOperatorToolsAndRelocation1787900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_coops" ADD "operator_verified" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `CREATE TYPE "coop_relocation_requests_status_enum" AS ENUM('open','resolved','dismissed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "coop_relocation_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "coop_id" uuid NOT NULL,
        "name" character varying NOT NULL,
        "situation" text NOT NULL,
        "user_id" uuid,
        "status" "coop_relocation_requests_status_enum" NOT NULL DEFAULT 'open',
        "outcome" text,
        "resolved_by_user_id" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coop_relocation_requests" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_relocation_requests_coop_id" ON "coop_relocation_requests" ("coop_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_coop_relocation_requests_user_id" ON "coop_relocation_requests" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" ADD CONSTRAINT "FK_coop_relocation_requests_coop_id" FOREIGN KEY ("coop_id") REFERENCES "housing_coops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" ADD CONSTRAINT "FK_coop_relocation_requests_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" DROP CONSTRAINT "FK_coop_relocation_requests_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coop_relocation_requests" DROP CONSTRAINT "FK_coop_relocation_requests_coop_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_coop_relocation_requests_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_coop_relocation_requests_coop_id"`,
    );
    await queryRunner.query(`DROP TABLE "coop_relocation_requests"`);
    await queryRunner.query(`DROP TYPE "coop_relocation_requests_status_enum"`);

    await queryRunner.query(
      `ALTER TABLE "housing_coops" DROP COLUMN "operator_verified"`,
    );
  }
}
