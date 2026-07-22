import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddListingSafeSpace1782800880000 implements MigrationInterface {
  name = 'AddListingSafeSpace1782800880000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listings_safe_space_status_enum" AS ENUM('none', 'verified', 'removed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings"
         ADD "safe_space_status" "listings_safe_space_status_enum" NOT NULL DEFAULT 'none',
         ADD "safe_space_tier" integer,
         ADD "safe_space_verifier" character varying NOT NULL DEFAULT '',
         ADD "safe_space_re_verified_at" date,
         ADD "safe_space_sub" text NOT NULL DEFAULT '',
         ADD "safe_space_promises" jsonb NOT NULL DEFAULT '[]',
         ADD "safe_space_vouches" jsonb NOT NULL DEFAULT '[]',
         ADD "safe_space_removal" jsonb`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listings_safe_space_status" ON "listings" ("safe_space_status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_listings_safe_space_status"`);
    await queryRunner.query(
      `ALTER TABLE "listings"
         DROP COLUMN "safe_space_removal",
         DROP COLUMN "safe_space_vouches",
         DROP COLUMN "safe_space_promises",
         DROP COLUMN "safe_space_sub",
         DROP COLUMN "safe_space_re_verified_at",
         DROP COLUMN "safe_space_verifier",
         DROP COLUMN "safe_space_tier",
         DROP COLUMN "safe_space_status"`,
    );
    await queryRunner.query(`DROP TYPE "listings_safe_space_status_enum"`);
  }
}
