// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAmbassadors1822400000000 implements MigrationInterface {
  name = 'AddAmbassadors1822400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ambassadors" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "focus_area" character varying(40) NOT NULL,
        "granted_by_id" uuid,
        "granted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "grant_reason" text NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_id" uuid,
        "revoke_reason" text,
        CONSTRAINT "PK_ambassadors_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ambassadors_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ambassadors_granted_by" FOREIGN KEY ("granted_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_ambassadors_revoked_by" FOREIGN KEY ("revoked_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ambassadors_user_id" ON "ambassadors" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_ambassadors_active_user" ON "ambassadors" ("user_id") WHERE "revoked_at" IS NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "ambassador_circle" (
        "id" smallint NOT NULL DEFAULT 1,
        "community_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ambassador_circle_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ambassador_circle_community" UNIQUE ("community_id"),
        CONSTRAINT "CHK_ambassador_circle_singleton" CHECK ("id" = 1),
        CONSTRAINT "FK_ambassador_circle_community" FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE RESTRICT
      )`);
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD COLUMN "is_ambassador_tag_visible" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP COLUMN "is_ambassador_tag_visible"`,
    );
    await queryRunner.query(`DROP TABLE "ambassador_circle"`);
    await queryRunner.query(
      `ALTER TABLE "ambassadors" DROP CONSTRAINT "FK_ambassadors_revoked_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ambassadors" DROP CONSTRAINT "FK_ambassadors_granted_by"`,
    );
    await queryRunner.query(`DROP TABLE "ambassadors"`);
  }
}
