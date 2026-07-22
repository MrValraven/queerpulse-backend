import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserIsSystem1782800840000 implements MigrationInterface {
  name = 'AddUserIsSystem1782800840000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "is_system" boolean NOT NULL DEFAULT false`,
    );
    // Backfill the permanent house account if it already exists (created by an
    // earlier genesis run). Literal sentinel — NOT an import from src/genesis,
    // which is a deletable module; migrations are frozen history and must not
    // depend on live source. A fresh bootstrap that runs AFTER this migration
    // is flagged by GenesisService instead (see Task 2).
    await queryRunner.query(
      `UPDATE "users" SET "is_system" = true WHERE "google_id" = 'system:queerpulse'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_system"`);
  }
}
