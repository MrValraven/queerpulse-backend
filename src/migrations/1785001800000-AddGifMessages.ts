import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'gif' message kind and the `attachment` jsonb column so a message can
 * carry a provider-hosted GIF. Additive: existing rows are untouched (attachment
 * defaults to NULL, kind stays 'user'/'system'). ADD VALUE is idempotent and,
 * on PG 12+, transaction-legal because 'gif' is not USED in this migration.
 */
export class AddGifMessages1785001800000 implements MigrationInterface {
  name = 'AddGifMessages1785001800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "messages_kind_enum" ADD VALUE IF NOT EXISTS 'gif'`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD COLUMN "attachment" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "attachment"`);
    // Postgres cannot drop a single enum value; leaving 'gif' is harmless — down()
    // only reverses the column, matching the repo's other enum-extend migrations.
  }
}
