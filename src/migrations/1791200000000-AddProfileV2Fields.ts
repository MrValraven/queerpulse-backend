import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfileV2Fields1791200000000 implements MigrationInterface {
  name = 'AddProfileV2Fields1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles"
        ADD COLUMN "pronunciation" varchar NULL,
        ADD COLUMN "bio_pt" text NULL,
        ADD COLUMN "not_here_for" text NULL,
        ADD COLUMN "photo_visible" boolean NOT NULL DEFAULT true,
        ADD COLUMN "hood_visible" boolean NOT NULL DEFAULT true,
        ADD COLUMN "vouchers_visible" boolean NOT NULL DEFAULT true,
        ADD COLUMN "hidden_until" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "profiles"
        DROP COLUMN "pronunciation",
        DROP COLUMN "bio_pt",
        DROP COLUMN "not_here_for",
        DROP COLUMN "photo_visible",
        DROP COLUMN "hood_visible",
        DROP COLUMN "vouchers_visible",
        DROP COLUMN "hidden_until"
    `);
  }
}
